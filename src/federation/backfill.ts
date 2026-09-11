import { Collection, CollectionPage, Create, Note, Object as ASObject, Question, isActor } from '@fedify/vocab'
import type { Context } from '@fedify/fedify'
import type { Env, StatusRow } from '../types'
import { accountById, all, one } from '../data'
import { digest } from '../auth/crypto'
import { blocked } from '../policy'
import { domainPolicy } from '../moderation-policy'
import { ApiError } from '../http'
import { nextId } from '../db'
import { federation } from './index'
import { persistStatus, safeUrl } from './receive'

export interface FollowBackfillPayload {
	followerId: string
	followingId: string
	followUri: string
}

const acceptedFollowSql = `EXISTS(SELECT 1 FROM follows f JOIN accounts a ON a.id=f.follower_id JOIN accounts r ON r.id=f.following_id WHERE f.follower_id=? AND f.following_id=? AND f.activity_uri=? AND f.state='accepted' AND a.domain='' AND a.disabled=0 AND a.suspended=0 AND r.domain<>'' AND r.disabled=0 AND r.suspended=0)`
const followBinds = (follow: FollowBackfillPayload) => [follow.followerId, follow.followingId, follow.followUri]

// One durable intent per accepted follow. Re-following has a new activity URI;
// refreshing the home timeline or retrying an old intent cannot create duplicates.
export async function followBackfillStatement(env: Env, follow: FollowBackfillPayload) {
	const id = 'follow-backfill:' + (await digest(JSON.stringify(followBinds(follow)))),
		time = Date.now()
	return env.DB.prepare(
		`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'federation.backfill',?,?,? WHERE ${acceptedFollowSql}`
	).bind(id, JSON.stringify(follow), time, time, ...followBinds(follow))
}

export async function queueFollowBackfill(env: Env, followerId: string) {
	// Exclude already prepared follows before LIMIT so repeated requests progress
	// through large following lists instead of revisiting the first batch forever.
	const follows = await all<FollowBackfillPayload>(
		env,
		`SELECT f.follower_id followerId,f.following_id followingId,f.activity_uri followUri FROM follows f
		JOIN accounts a ON a.id=f.follower_id JOIN accounts r ON r.id=f.following_id
		WHERE f.follower_id=? AND f.state='accepted' AND a.domain='' AND a.disabled=0 AND a.suspended=0 AND r.domain<>'' AND r.disabled=0 AND r.suspended=0
		AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='federation.backfill' AND json_extract(j.payload,'$.followerId')=f.follower_id AND json_extract(j.payload,'$.followingId')=f.following_id AND json_extract(j.payload,'$.followUri')=f.activity_uri)
		ORDER BY f.id LIMIT 20`,
		followerId
	)
	if (!follows.length) return 0
	const result = await env.DB.batch(await Promise.all(follows.map((follow) => followBackfillStatement(env, follow))))
	return result.reduce((count, row) => count + row.meta.changes, 0)
}

async function allowed(env: Env, follow: FollowBackfillPayload) {
	if (!(await one(env, 'SELECT 1 WHERE ' + acceptedFollowSql, ...followBinds(follow)))) return false
	const remote = await accountById(env, follow.followingId)
	return !(
		(await blocked(env, follow.followerId, remote.id)) ||
		(await domainPolicy(env, remote.domain!)).suspended ||
		(await one(
			env,
			'SELECT 1 FROM user_domain_blocks WHERE account_id=? AND domain=?',
			follow.followerId,
			remote.domain!
		))
	)
}

async function historicalId(env: Env, published: number) {
	// Recent arrivals share the normal allocator. Old history needs a timestamp
	// in the ID so Mastodon clients' ID cursors retain chronological ordering.
	if (published > Date.now() - 60000) return nextId(env.DB)
	const lower = BigInt(published) << 16n,
		upper = lower + 65535n,
		row = await env.DB.prepare(
			`INSERT INTO sequences(name,value)
			SELECT ?,MAX(CAST(? AS INTEGER),COALESCE((SELECT MAX(sequence)+1 FROM statuses WHERE sequence BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER)),0))
			ON CONFLICT(name) DO UPDATE SET value=MAX(sequences.value+1,excluded.value)
			RETURNING CAST(value AS TEXT) id`
		)
			.bind('history:' + published, lower.toString(), lower.toString(), upper.toString())
			.first<{ id: string }>()
	if (!row || BigInt(row.id) > upper) throw new ApiError(422, 'Historical post timestamp is full')
	return row.id
}

export async function processFollowBackfill(env: Env, follow: FollowBackfillPayload) {
	const deadline = Date.now() + 120000,
		attemptSignal = AbortSignal.timeout(120000)
	const checkDeadline = () => {
		attemptSignal.throwIfAborted()
		if (Date.now() >= deadline) throw new DOMException('Follow history attempt timed out', 'TimeoutError')
	}
	if (!follow || !follow.followerId || !follow.followingId || !follow.followUri || !(await allowed(env, follow))) return
	const follower = await accountById(env, follow.followerId),
		remote = await accountById(env, follow.followingId),
		actorUri = safeUrl(remote.uri)
	if (!actorUri) return
	const origin = new URL(actorUri).origin,
		ctx = (await federation(env)).createContext(new Request(env.PUBLIC_ORIGIN), env),
		signedLoader = await ctx.getDocumentLoader({ identifier: follower.username }),
		permitted = new Set([actorUri]),
		visited = new Set<string>()
	let requests = 0
	const permit = (url: URL | null | undefined): url is URL => {
		if (!url || !safeUrl(url) || url.origin !== origin) return false
		permitted.add(url.href)
		return true
	}
	// Only the followed actor and links explicitly encountered in its bounded
	// outbox traversal may be read. In particular, historical replies and quotes
	// must not recursively discover third-party accounts or conversations.
	const documentLoader: Context<Env>['documentLoader'] = async (url, options) => {
		checkDeadline()
		if (!permitted.has(url) || ++requests > 85) throw new ApiError(422, 'Outside the follow history selection')
		if (!(await allowed(env, follow))) throw new ApiError(422, 'Follow is no longer active')
		const signal = AbortSignal.any([
				attemptSignal,
				AbortSignal.timeout(20000),
				...(options?.signal ? [options.signal] : []),
			]),
			result = await signedLoader(url, { ...options, signal })
		signal.throwIfAborted()
		checkDeadline()
		if (!safeUrl(result.documentUrl) || new URL(result.documentUrl).origin !== origin)
			throw new ApiError(422, 'Cross-origin history response')
		return result
	}
	const loaders = { documentLoader, contextLoader: ctx.contextLoader, tracerProvider: ctx.tracerProvider }
	const readObject = async (url: string) => {
		// lookupObject falls back to WebFinger after a failed document fetch and
		// can hide transport failures. These are already canonical actor/outbox
		// URLs; preserve their timeout so the durable job retries the same intent.
		const result = await documentLoader(url)
		return ASObject.fromJsonLd(result.document, { ...loaders, baseUrl: new URL(result.documentUrl) })
	}
	const actor = await readObject(actorUri)
	if (!actor || !isActor(actor) || actor.id?.href !== actorUri || !permit(actor.outboxId)) return
	const outbox = await actor.getOutbox(loaders)
	if (!outbox || (outbox.id && outbox.id.href !== actor.outboxId!.href)) return
	let page: Collection | null = outbox,
		pages = 0,
		scanned = 0
	const selected = new Map<string, Note | Question>()
	while (page && pages < 2 && scanned < 40) {
		checkDeadline()
		if (page.id) {
			if (page.id.origin !== origin || visited.has(page.id.href)) break
			visited.add(page.id.href)
		}
		if (page instanceof CollectionPage && page.partOfId && page.partOfId.href !== actor.outboxId!.href) break
		// Slice before parsing or dereferencing individual entries. An oversized or
		// malformed collection cannot turn this into an unbounded actor crawl.
		const raw = (await page.toJsonLd({ format: 'compact' })) as Record<string, unknown>,
			items = raw.orderedItems ?? raw.items ?? [],
			entries = (Array.isArray(items) ? items : [items]).slice(0, 40 - scanned)
		if (!entries.length && page === outbox && permit(page.firstId) && !visited.has(page.firstId!.href)) {
			page = await page.getFirst(loaders)
			continue
		}
		pages++
		for (const entry of entries) {
			checkDeadline()
			scanned++
			try {
				let item: ASObject | null
				if (typeof entry === 'string') {
					const id = new URL(entry)
					if (!permit(id)) continue
					item = await readObject(id.href)
				} else if (entry && typeof entry === 'object')
					item = await ASObject.fromJsonLd({ '@context': raw['@context'], ...entry }, loaders)
				else continue
				if (item instanceof Create) {
					if (item.actorIds.length !== 1 || item.actorId?.href !== actorUri || !item.id || item.id.origin !== origin)
						continue
					if (!permit(item.objectId)) continue
					item = await item.getObject(loaders)
				}
				if (
					(!(item instanceof Note) && !(item instanceof Question)) ||
					!item.id ||
					item.id.origin !== origin ||
					!safeUrl(item.id) ||
					item.attributionIds.length !== 1 ||
					item.attributionId?.href !== actorUri ||
					!item.toIds.some((url) => url.href === 'https://www.w3.org/ns/activitystreams#Public') ||
					!item.published ||
					!Number.isSafeInteger(Number(item.published.epochMilliseconds)) ||
					Number(item.published.epochMilliseconds) <= 0 ||
					Number(item.published.epochMilliseconds) > Date.now() + 300000
				)
					continue
				selected.set(item.id.href, item)
			} catch (error) {
				// A single unsupported or malformed entry does not hide the rest of
				// a valid collection. Infrastructure failures still retry the job.
				if (!(error instanceof TypeError) && !(error instanceof ApiError && error.status === 422)) throw error
			}
		}
		if (
			pages >= 2 ||
			scanned >= 40 ||
			!(page instanceof CollectionPage) ||
			!permit(page.nextId) ||
			visited.has(page.nextId!.href)
		)
			break
		page = await page.getNext(loaders)
	}
	const recent = [...selected.values()]
		.sort((a, b) => Number(b.published!.epochMilliseconds) - Number(a.published!.epochMilliseconds))
		.slice(0, 20)
	// Oldest first retains chronological order while preserving source dates.
	for (const status of recent.reverse()) {
		checkDeadline()
		if (!(await allowed(env, follow))) return
		if (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE uri=?', status.id!.href)) continue
		try {
			checkDeadline()
			await persistStatus(ctx, status, remote, 2, {
				quiet: true,
				documentLoader,
				id: await historicalId(env, Number(status.published!.epochMilliseconds)),
			})
		} catch (error) {
			if (!(error instanceof TypeError) && !(error instanceof ApiError && error.status === 422)) throw error
		}
	}
}
