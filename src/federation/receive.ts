import {
	Activity,
	Object as ASObject,
	Note,
	Question,
	Create,
	Update,
	Delete,
	Follow,
	Accept,
	Reject,
	Undo,
	Like,
	Announce,
	Block,
	Move,
	Flag,
	Add,
	Remove,
	isActor,
	type Actor,
} from '@fedify/vocab'
import type { Context, InboxContext } from '@fedify/fedify'
import sanitizeHtml from 'sanitize-html'
import type { AccountRow, Env, StatusRow } from '../types'
import { accountById, accountUri, all, now, one, parsed, run } from '../data'
import { nextId } from '../db'
import { ApiError } from '../http'
import { digest } from '../auth/crypto'
import { outboundStatement } from './outbox'
import { followHistoryStatement } from './history'
import { followBackfillStatement } from './backfill'
import { notificationStatements } from '../notifications'
import { migrateLocalFollowers } from '../lifecycle'
import { domainPolicy } from '../moderation-policy'
import { blocked, visible } from '../policy'
import { D1KvStore } from './storage'
import { consentActivity, uriOf } from './consent'

export function cleanHtml(value: string) {
	return sanitizeHtml(value, {
		allowedTags: [
			'p',
			'br',
			'a',
			'span',
			'strong',
			'em',
			'b',
			'i',
			'u',
			's',
			'blockquote',
			'code',
			'pre',
			'ul',
			'ol',
			'li',
		],
		allowedAttributes: { a: ['href', 'rel', 'class'], span: ['class'] },
		allowedSchemes: ['http', 'https', 'mailto'],
		transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer' }) },
	})
}
const text = (v: unknown) => (typeof v === 'string' ? v : '')
export function safeUrl(value: unknown): string | null {
	try {
		const u = new URL(String(value))
		return u.protocol === 'https:' && !u.username && !u.password ? u.href : null
	} catch {
		return null
	}
}
export async function persistActor(
	ctx: Context<Env>,
	actor: Actor,
	documentLoader?: Context<Env>['documentLoader']
): Promise<AccountRow> {
	if (!actor.id || !actor.preferredUsername || !actor.inboxId) throw new ApiError(422, 'Incomplete remote actor')
	const uri = actor.id.href,
		domain = actor.id.hostname
	if (actor.id.origin === new URL(ctx.data.PUBLIC_ORIGIN).origin) {
		const a = await one<AccountRow>(
			ctx.data,
			"SELECT * FROM accounts WHERE domain='' AND username=?",
			String(actor.preferredUsername)
		)
		if (!a || accountUri(ctx.data, a) !== uri) throw new ApiError(422, 'Invalid local actor')
		return a
	}
	if ((await domainPolicy(ctx.data, domain)).suspended) throw new ApiError(422, 'Blocked federation domain')
	const existing = await one<AccountRow>(ctx.data, 'SELECT * FROM accounts WHERE uri=?', uri),
		id = existing?.id ?? (await nextId(ctx.data.DB)),
		json = (await actor.toJsonLd()) as Record<string, unknown>
	const loaders = documentLoader
			? { documentLoader, contextLoader: ctx.contextLoader, tracerProvider: ctx.tracerProvider }
			: ctx,
		icon = await actor.getIcon(loaders),
		image = await actor.getImage(loaders),
		attachments = []
	for await (const field of actor.getAttachments(loaders)) {
		const f = (await field.toJsonLd()) as Record<string, unknown>
		if (f.type === 'PropertyValue' && attachments.length < 4)
			attachments.push({ name: text(f.name).slice(0, 255), value: cleanHtml(text(f.value)), verified_at: null })
	}
	const inbox = safeUrl(actor.inboxId.href)
	if (!inbox) throw new ApiError(422, 'Invalid remote inbox')
	await run(
		ctx.data,
		`INSERT INTO accounts(id,username,domain,uri,url,inbox,shared_inbox,outbox,followers_url,following_url,display_name,note,created_at,locked,bot,discoverable,indexable,avatar,header,fields,aliases,public_keys) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uri) DO UPDATE SET display_name=excluded.display_name,note=excluded.note,inbox=excluded.inbox,shared_inbox=excluded.shared_inbox,locked=excluded.locked,avatar=excluded.avatar,header=excluded.header,fields=excluded.fields,aliases=excluded.aliases,public_keys=excluded.public_keys,discoverable=excluded.discoverable,indexable=excluded.indexable,bot=excluded.bot`,
		id,
		String(actor.preferredUsername),
		domain,
		uri,
		safeUrl(actor.url),
		inbox,
		safeUrl(actor.endpoints?.sharedInbox),
		safeUrl(actor.outboxId),
		safeUrl(actor.followersId),
		safeUrl(actor.followingId),
		String(actor.name ?? ''),
		cleanHtml(String(actor.summary ?? '')),
		actor.published?.toString() ?? now(),
		actor.manuallyApprovesFollowers ? 1 : 0,
		json.type === 'Service' ? 1 : 0,
		actor.discoverable ? 1 : 0,
		actor.indexable ? 1 : 0,
		safeUrl(icon?.url),
		safeUrl(image?.url),
		JSON.stringify(attachments),
		JSON.stringify(actor.aliasIds.map((u) => u.href)),
		JSON.stringify(json.publicKey ?? [])
	)
	if (json.interactionPolicy && typeof json.interactionPolicy === 'object') {
		const policy = (json.interactionPolicy as Record<string, unknown>).canFeature
		if (policy && typeof policy === 'object')
			await run(
				ctx.data,
				"UPDATE accounts SET preferences=json_set(preferences,'$.feature_policy',json(?)) WHERE id=?",
				JSON.stringify(policy),
				id
			)
	}
	return accountById(ctx.data, id)
}
export async function persistStatus(
	ctx: Context<Env>,
	object: ASObject,
	actor: AccountRow,
	depth = 0,
	options: { quiet?: boolean; documentLoader?: Context<Env>['documentLoader']; id?: string } = {}
): Promise<StatusRow | null> {
	const loaders = options.documentLoader
		? { documentLoader: options.documentLoader, contextLoader: ctx.contextLoader, tracerProvider: ctx.tracerProvider }
		: ctx
	if (!(object instanceof Note) && !(object instanceof Question)) throw new ApiError(422, 'Unsupported status object')
	if (!object.id || object.attributionId?.href !== accountUri(ctx.data, actor))
		throw new ApiError(422, 'Object attribution does not match its actor')
	if (object.id.origin !== new URL(accountUri(ctx.data, actor)).origin)
		throw new ApiError(422, 'Cross-origin object identity')
	const kv = new D1KvStore(ctx.data)
	if (await kv.get(['tombstone', object.id.href])) return null
	const existing = await one<StatusRow>(ctx.data, 'SELECT * FROM statuses WHERE uri=?', object.id.href)
	if (existing?.local) throw new ApiError(422, 'Remote activity cannot modify a local post')
	if (
		existing &&
		(existing.deleted_at ||
			Date.parse(existing.edited_at ?? existing.created_at) >=
				Number(object.updated?.epochMilliseconds ?? object.published?.epochMilliseconds ?? 0))
	)
		return existing
	const addressed = [...object.toIds, ...object.ccIds].map((u) => u.href),
		pub = 'https://www.w3.org/ns/activitystreams#Public'
	const visibility = object.toIds.some((u) => u.href === pub)
		? 'public'
		: object.ccIds.some((u) => u.href === pub)
			? 'unlisted'
			: actor.followers_url && addressed.includes(actor.followers_url)
				? 'private'
				: 'direct'
	const id = existing?.id ?? options.id ?? (await nextId(ctx.data.DB)),
		content = cleanHtml(String(object.content ?? '')),
		plain = sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} }),
		recipients: AccountRow[] = [],
		tags: string[] = [],
		media: Record<string, unknown>[] = []
	for (const address of addressed) {
		const a =
			(await one<AccountRow>(ctx.data, 'SELECT * FROM accounts WHERE uri=?', address)) ??
			(await one<AccountRow>(
				ctx.data,
				"SELECT * FROM accounts WHERE domain='' AND ?=?||'/users/'||username",
				address,
				ctx.data.PUBLIC_ORIGIN
			))
		if (a && !recipients.some((r) => r.id === a.id)) recipients.push(a)
	}
	for await (const tag of object.getTags(loaders)) {
		const j = (await tag.toJsonLd()) as Record<string, unknown>
		if (j.type === 'Hashtag') {
			const name = text(j.name).replace(/^#/, '').toLocaleLowerCase()
			if (/^[\p{L}\p{N}_]{1,100}$/u.test(name)) tags.push(name)
		}
	}
	let parent = object.replyTargetId
		? await one<StatusRow>(ctx.data, 'SELECT * FROM statuses WHERE uri=?', object.replyTargetId.href)
		: null
	if (!parent && object.replyTargetId && depth < 2) {
		const p = await ctx.lookupObject(object.replyTargetId, options)
		if (p?.attributionId) {
			const author = await ctx.lookupObject(p.attributionId, options)
			if (author && isActor(author))
				parent = await persistStatus(ctx, p, await persistActor(ctx, author, options.documentLoader), depth + 1, {
					...options,
					id: undefined,
				})
		}
	}
	const raw = (await object.toJsonLd()) as Record<string, unknown>,
		quoteURI = uriOf(raw.quote) ?? (object instanceof Note ? (object.quoteId?.href ?? null) : null),
		authorization = uriOf(raw.quoteAuthorization)
	let quote = quoteURI ? await localStatusByUri(ctx.data, quoteURI) : null
	if (!quote && quoteURI && depth < 2) {
		const q = await ctx.lookupObject(quoteURI, options)
		if (q?.attributionId) {
			const a = await ctx.lookupObject(q.attributionId, options)
			if (a && isActor(a))
				quote = await persistStatus(ctx, q, await persistActor(ctx, a, options.documentLoader), depth + 1, {
					...options,
					id: undefined,
				})
		}
	}
	let quoteState = quote ? 'pending' : null
	if (quote && authorization && ['public', 'unlisted'].includes(quote.visibility)) {
		const qa = await accountById(ctx.data, quote.account_id)
		if (quote.local) {
			const proof = await one(
				ctx.data,
				"SELECT 1 FROM quote_requests WHERE quote_uri=? AND target_id=? AND authorization=? AND state='accepted'",
				object.id.href,
				quote.id,
				authorization
			)
			if (proof) quoteState = 'accepted'
		} else if (safeUrl(authorization) && new URL(authorization).origin === new URL(accountUri(ctx.data, qa)).origin) {
			const proof = (await loaders.documentLoader(authorization)).document as Record<string, unknown>
			if (
				proof.type === 'QuoteAuthorization' &&
				uriOf(proof.interactionTarget) === quoteURI &&
				uriOf(proof.interactingObject) === object.id.href
			)
				quoteState = 'accepted'
		}
	}
	const policy = raw.interactionPolicy as { canQuote?: { automaticApproval?: unknown[] } } | undefined,
		automatic = policy?.canQuote?.automaticApproval ?? [],
		quotePolicy = automatic.includes(pub)
			? 'public'
			: actor.followers_url && automatic.includes(actor.followers_url)
				? 'followers'
				: 'nobody'
	const revision = (existing?.revision ?? 0) + 1,
		mutation = crypto.randomUUID(),
		published = object.published?.toString() ?? now(),
		edited = existing ? (object.updated?.toString() ?? now()) : null
	const statements = [
		ctx.data.DB.prepare(
			`INSERT INTO statuses(id,sequence,account_id,text,content,spoiler_text,visibility,sensitive,language,in_reply_to_id,created_at,edited_at,mutation_id,uri,url,local,revision,conversation_id) VALUES(?,CAST(? AS INTEGER),?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(uri) WHERE uri IS NOT NULL DO UPDATE SET text=excluded.text,content=excluded.content,spoiler_text=excluded.spoiler_text,sensitive=excluded.sensitive,edited_at=excluded.edited_at,revision=excluded.revision,mutation_id=excluded.mutation_id WHERE statuses.local=0 AND statuses.account_id=excluded.account_id`
		).bind(
			id,
			id,
			actor.id,
			plain,
			content,
			String(object.summary ?? ''),
			visibility,
			object.sensitive ? 1 : 0,
			null,
			parent?.id ?? null,
			published,
			edited,
			mutation,
			object.id.href,
			safeUrl(object.url),
			revision,
			parent?.conversation_id ?? (visibility === 'direct' ? id : null)
		),
	]
	statements.push(
		ctx.data.DB.prepare(
			'UPDATE statuses SET quote_id=?,quote_state=?,quote_authorization=?,quote_policy=? WHERE id=? AND local=0'
		).bind(quote?.id ?? null, quoteState, authorization, quotePolicy, id)
	)
	if (existing) statements.push(ctx.data.DB.prepare('DELETE FROM status_tags WHERE status_id=?').bind(id))
	for (const a of existing && ['private', 'direct'].includes(existing.visibility) ? [] : recipients)
		statements.push(
			ctx.data.DB.prepare('INSERT OR IGNORE INTO status_recipients(status_id,account_id) VALUES(?,?)').bind(id, a.id)
		)
	for (const name of tags) {
		statements.push(
			ctx.data.DB.prepare('INSERT OR IGNORE INTO tags(name,display_name,created_at) VALUES(?,?,?)').bind(
				name,
				name,
				now()
			),
			ctx.data.DB.prepare('INSERT OR IGNORE INTO status_tags(status_id,tag) VALUES(?,?)').bind(id, name)
		)
	}
	// Remote files keep their source URLs and are fetched only on demand. They
	// never become trusted HTML and only public HTTP(S) URLs are retained.
	const remoteFiles = []
	const rejectMedia = actor.domain && (await domainPolicy(ctx.data, actor.domain)).rejectMedia
	let position = 0
	for await (const attachment of object.getAttachments(loaders)) {
		if (rejectMedia || position >= 4) break
		const j = (await attachment.toJsonLd()) as Record<string, unknown>,
			url = safeUrl(uriOf(j.url)),
			mime = String(j.mediaType ?? 'application/octet-stream'),
			kind = mime.startsWith('image/')
				? 'image'
				: mime.startsWith('video/')
					? 'video'
					: mime.startsWith('audio/')
						? 'audio'
						: null
		if (!url || !kind) continue
		const mediaId = await nextId(ctx.data.DB),
			meta = {
				original: { width: Number(j.width) || undefined, height: Number(j.height) || undefined },
				blurhash: typeof j.blurhash === 'string' ? j.blurhash : null,
			}
		remoteFiles.push(mediaId)
		statements.push(
			ctx.data.DB.prepare(
				`INSERT INTO media_attachments(id,account_id,status_id,state,original_key,mime_type,media_type,bytes,description,metadata,created_at,updated_at,position,remote_url,preview_remote_url) VALUES(?,?,?,'ready',?,?,?,?,?,?,?,?,?,?,?)`
			).bind(
				mediaId,
				actor.id,
				id,
				'remote/' + crypto.randomUUID(),
				mime,
				kind,
				0,
				typeof j.name === 'string' ? j.name.slice(0, 1500) : null,
				JSON.stringify(meta),
				Date.now(),
				Date.now(),
				position++,
				url,
				safeUrl(uriOf(j.icon))
			)
		)
	}
	if (existing)
		statements.splice(
			1,
			0,
			ctx.data.DB.prepare(
				'UPDATE media_attachments SET status_id=NULL WHERE status_id=? AND remote_url IS NOT NULL'
			).bind(id)
		)
	// Keep a complete source revision before delivering notifications or streams.
	statements.push(
		ctx.data.DB.prepare(
			'INSERT OR IGNORE INTO status_revisions(status_id,revision,snapshot,created_at) VALUES(?,?,?,?)'
		).bind(
			id,
			revision,
			JSON.stringify({
				id,
				account_id: actor.id,
				text: plain,
				content,
				spoiler_text: String(object.summary ?? ''),
				sensitive: object.sensitive ? 1 : 0,
				created_at: edited ?? published,
			}),
			edited ?? published
		)
	)
	if (object instanceof Question) {
		const pollOptions: { name: string; votes: number }[] = []
		for await (const choice of object.getExclusiveOptions(loaders))
			pollOptions.push({
				name: String(choice.name ?? ''),
				votes: Number((await choice.getReplies(loaders))?.totalItems ?? 0),
			})
		let multiple = false
		if (!pollOptions.length) {
			multiple = true
			for await (const choice of object.getInclusiveOptions(loaders))
				pollOptions.push({
					name: String(choice.name ?? ''),
					votes: Number((await choice.getReplies(loaders))?.totalItems ?? 0),
				})
		}
		if (pollOptions.length >= 2) {
			const importedAt = now(),
				expiresAt = object.endTime?.toString() ?? importedAt
			statements.push(
				ctx.data.DB.prepare(
					// Already-closed history must not generate a delayed live event in
					// the expiry sweep. Preserve an existing poll's notification state.
					`INSERT INTO polls(id,status_id,multiple,expires_at,options,remote_votes,notified_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(status_id) DO UPDATE SET expires_at=excluded.expires_at,options=excluded.options,remote_votes=excluded.remote_votes`
				).bind(
					id,
					id,
					+multiple,
					expiresAt,
					JSON.stringify(pollOptions.map((o) => o.name)),
					JSON.stringify(pollOptions.map((o) => o.votes)),
					options.quiet && Date.parse(expiresAt) <= Date.parse(importedAt) ? importedAt : null
				)
			)
		}
	}
	if (!options.quiet)
		statements.push(
			ctx.data.DB.prepare(
				`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'status.event',?,?,?)`
			).bind(`status:${id}:${revision}`, JSON.stringify({ statusId: id }), Date.now(), Date.now())
		)
	await ctx.data.DB.batch(statements)
	if (!existing && !options.quiet) {
		for (const a of recipients) {
			const ns = await notificationStatements(ctx.data, a.id, actor.id, 'mention', id, 'mention:' + id + ':' + a.id)
			if (ns.length) await ctx.data.DB.batch(ns)
		}
	}
	return (await one<StatusRow>(ctx.data, 'SELECT * FROM statuses WHERE id=?', id))!
}

async function inboxActorDocumentLoader(ctx: InboxContext<Env>, actorId: URL) {
	// Secure-mode servers require signed actor reads. Use this inbox's active
	// recipient, or an active local follower for activities in the shared inbox.
	const recipient = ctx.recipient ?? null,
		local = await one<{ username: string }>(
			ctx.data,
			`SELECT a.username FROM accounts a WHERE a.domain='' AND a.disabled=0 AND a.suspended=0 AND a.approved=1 AND (a.email IS NULL OR a.email_confirmed=1) AND (a.username=? OR EXISTS(SELECT 1 FROM follows f JOIN accounts remote ON remote.id=f.following_id WHERE f.follower_id=a.id AND f.state IN ('pending','accepted') AND remote.uri=?)) ORDER BY CASE WHEN a.username=? THEN 0 ELSE 1 END,a.id LIMIT 1`,
			recipient,
			actorId.href,
			recipient
		)
	return local ? ctx.getDocumentLoader({ identifier: local.username }) : undefined
}

export async function receive(ctx: InboxContext<Env>, activity: Activity) {
	if (!activity.id || !activity.actorId || activity.id.origin !== activity.actorId.origin)
		throw new ApiError(422, 'An activity needs a stable ID and actor')
	if (await one(ctx.data, 'SELECT id FROM federation_inbox WHERE id=?', activity.id.href)) return
	const documentLoader = await inboxActorDocumentLoader(ctx, activity.actorId),
		loaders = documentLoader
			? { documentLoader, contextLoader: ctx.contextLoader, tracerProvider: ctx.tracerProvider }
			: ctx,
		remote = await activity.getActor(loaders)
	if (!remote || !isActor(remote) || remote.id?.href !== activity.actorId.href)
		throw new ApiError(422, 'Invalid activity actor')
	const actor = await persistActor(ctx, remote, documentLoader),
		env = ctx.data,
		serialized = (await activity.toJsonLd()) as Record<string, unknown>
	if (await consentActivity(ctx, serialized, actor)) {
		await run(
			env,
			'INSERT OR IGNORE INTO federation_inbox VALUES(?,?,?,?)',
			activity.id.href,
			activity.actorId.href,
			JSON.stringify(serialized),
			now()
		)
		return
	}
	if (!actor.domain) throw new ApiError(422, 'Remote inbox cannot impersonate a local actor')
	if (activity instanceof Follow) {
		const target = activity.objectId
			? await one<AccountRow>(
					env,
					"SELECT * FROM accounts WHERE uri=? OR (domain='' AND ?=?||'/users/'||username)",
					activity.objectId.href,
					activity.objectId.href,
					env.PUBLIC_ORIGIN
				)
			: null
		if (
			target &&
			!target.domain &&
			!target.suspended &&
			!target.disabled &&
			!(await blocked(env, target.id, actor.id)) &&
			!(await one(env, 'SELECT 1 FROM user_domain_blocks WHERE account_id=? AND domain=?', target.id, actor.domain))
		) {
			const id = await nextId(env.DB),
				state = target.locked ? 'pending' : 'accepted',
				statements = [
					env.DB.prepare(
						`INSERT INTO follows(id,follower_id,following_id,state,activity_uri,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(follower_id,following_id) DO UPDATE SET activity_uri=excluded.activity_uri`
					).bind(id, actor.id, target.id, state, activity.id.href, now()),
					...(await notificationStatements(
						env,
						target.id,
						actor.id,
						state === 'pending' ? 'follow_request' : 'follow',
						null,
						'follow:' + activity.id.href
					)),
				]
			if (state === 'accepted')
				statements.push(
					outboundStatement(
						env,
						target.id,
						{ type: 'Accept', actor: accountUri(env, target), object: serialized },
						[actor.id],
						'accept-' + (await digest(activity.id.href))
					),
					await followHistoryStatement(env, {
						actorId: target.id,
						followerId: actor.id,
						followUri: activity.id.href,
						acceptedAt: now(),
					})
				)
			await env.DB.batch(statements)
		}
	} else if (activity instanceof Accept || activity instanceof Reject) {
		// Mastodon can reference the original Follow by URI instead of embedding
		// it. Our ledger identifies the exact request and its intended recipient;
		// dereferencing that URI is unnecessary and may not be supported.
		if (activity.objectId) {
			const follow = await one<{ follower_id: string }>(
				env,
				"SELECT f.follower_id FROM follows f JOIN accounts a ON a.id=f.follower_id WHERE f.activity_uri=? AND f.following_id=? AND a.domain=''",
				activity.objectId.href,
				actor.id
			)
			if (follow) {
				const statements = [
					env.DB.prepare(
						`${activity instanceof Accept ? "UPDATE follows SET state='accepted'" : 'DELETE FROM follows'} WHERE activity_uri=? AND following_id=? AND follower_id=?`
					).bind(activity.objectId.href, actor.id, follow.follower_id),
				]
				if (activity instanceof Accept)
					statements.push(
						await followBackfillStatement(env, {
							followerId: follow.follower_id,
							followingId: actor.id,
							followUri: activity.objectId.href,
						})
					)
				await env.DB.batch(statements)
			}
		}
	} else if (activity instanceof Create || activity instanceof Update) {
		const obj = await activity.getObject(loaders)
		if (obj && isActor(obj)) {
			if (obj.id?.href !== remote.id?.href) throw new ApiError(422, 'Actor update ownership mismatch')
			await persistActor(ctx, obj, documentLoader)
		} else if (obj) {
			if (!(await receiveVote(ctx, obj, actor, activity.id.href)))
				await persistStatus(ctx, obj, actor, 0, { documentLoader })
		}
	} else if (activity instanceof Delete) {
		const uri = activity.objectId?.href
		if (uri === accountUri(env, actor)) {
			await env.DB.batch([
				env.DB.prepare('UPDATE accounts SET suspended=1 WHERE id=?').bind(actor.id),
				env.DB.prepare('UPDATE statuses SET deleted_at=?,revision=revision+1 WHERE account_id=?').bind(now(), actor.id),
			])
		} else if (uri) {
			if (new URL(uri).origin !== remote.id!.origin) throw new ApiError(422, 'Delete ownership mismatch')
			await new D1KvStore(env).set(['tombstone', uri], { actor: accountUri(env, actor) })
			await run(
				env,
				'UPDATE statuses SET deleted_at=?,revision=revision+1 WHERE uri=? AND account_id=? AND local=0',
				now(),
				uri,
				actor.id
			)
		}
	} else if (activity instanceof Like) {
		const s = activity.objectId
			? await one<StatusRow>(
					env,
					'SELECT * FROM statuses WHERE uri=? OR (?=?||id)',
					activity.objectId.href,
					activity.objectId.href,
					env.PUBLIC_ORIGIN + '/statuses/'
				)
			: null
		const status = s ?? (activity.objectId ? await localStatusByUri(env, activity.objectId.href) : null)
		if (status && (await visible(env, status, actor.id))) {
			const id = await nextId(env.DB)
			await env.DB.batch([
				env.DB.prepare(
					"INSERT OR IGNORE INTO interactions(id,account_id,status_id,kind,activity_uri,created_at) VALUES(?,?,?,'favourite',?,?)"
				).bind(id, actor.id, status.id, activity.id.href, now()),
				...(await notificationStatements(
					env,
					status.account_id,
					actor.id,
					'favourite',
					status.id,
					'like:' + activity.id.href
				)),
			])
		}
	} else if (activity instanceof Announce) {
		let s = activity.objectId ? await localStatusByUri(env, activity.objectId.href) : null
		if (!s) {
			const obj = await activity.getObject(loaders)
			if (obj?.attributionId) {
				const author = await ctx.lookupObject(obj.attributionId, { documentLoader })
				if (author && isActor(author))
					s = await persistStatus(ctx, obj, await persistActor(ctx, author, documentLoader), 0, { documentLoader })
			}
		}
		if (s && ['public', 'unlisted'].includes(s.visibility)) {
			const id = await nextId(env.DB)
			await env.DB.batch([
				env.DB.prepare(
					`INSERT OR IGNORE INTO statuses(id,sequence,account_id,text,content,visibility,created_at,mutation_id,uri,local,reblog_of_id) VALUES(?,CAST(? AS INTEGER),?,'','','public',?,?,?,0,?)`
				).bind(id, id, actor.id, activity.published?.toString() ?? now(), crypto.randomUUID(), activity.id.href, s.id),
				...(await notificationStatements(env, s.account_id, actor.id, 'reblog', s.id, 'announce:' + activity.id.href)),
			])
		}
	} else if (activity instanceof Undo) {
		const obj = await activity.getObject(loaders)
		if (!(obj instanceof Activity) || obj.actorId?.href !== activity.actorId.href)
			throw new ApiError(422, 'Undo ownership mismatch')
		if (obj instanceof Follow)
			await run(env, 'DELETE FROM follows WHERE follower_id=? AND activity_uri=?', actor.id, obj.id?.href ?? '')
		else if (obj instanceof Like)
			await run(env, 'DELETE FROM interactions WHERE account_id=? AND activity_uri=?', actor.id, obj.id?.href ?? '')
		else if (obj instanceof Announce)
			await run(
				env,
				'UPDATE statuses SET deleted_at=?,revision=revision+1 WHERE account_id=? AND uri=? AND reblog_of_id IS NOT NULL',
				now(),
				actor.id,
				obj.id?.href ?? ''
			)
		else if (obj instanceof Block) {
			const target = obj.objectId
				? await one<AccountRow>(env, 'SELECT * FROM accounts WHERE uri=?', obj.objectId.href)
				: null
			if (target)
				await run(
					env,
					"DELETE FROM account_actions WHERE account_id=? AND target_id=? AND kind='block'",
					actor.id,
					target.id
				)
		}
	} else if (activity instanceof Block) {
		const target = activity.objectId
			? await one<AccountRow>(
					env,
					"SELECT * FROM accounts WHERE uri=? OR (domain='' AND ?=?||'/users/'||username)",
					activity.objectId.href,
					activity.objectId.href,
					env.PUBLIC_ORIGIN
				)
			: null
		if (target)
			await env.DB.batch([
				env.DB.prepare(
					"INSERT OR IGNORE INTO account_actions(id,account_id,target_id,kind,created_at) VALUES(?,?,?,'block',?)"
				).bind(await nextId(env.DB), actor.id, target.id, now()),
				env.DB.prepare(
					'DELETE FROM follows WHERE (follower_id=? AND following_id=?) OR (follower_id=? AND following_id=?)'
				).bind(actor.id, target.id, target.id, actor.id),
			])
	} else if (activity instanceof Move) {
		if (activity.objectId?.href !== activity.actorId.href || !activity.targetId)
			throw new ApiError(422, 'Invalid account move')
		const target = await ctx.lookupObject(activity.targetId)
		if (!target || !isActor(target) || !target.aliasIds.some((u) => u.href === activity.actorId!.href))
			throw new ApiError(422, 'Move target must alias its source')
		const moved = await persistActor(ctx, target)
		await run(env, 'UPDATE accounts SET moved_to_id=?,moved_at=? WHERE id=?', moved.id, now(), actor.id)
		await migrateLocalFollowers(env, actor, moved)
	} else if (activity instanceof Flag) {
		if ((await domainPolicy(env, actor.domain!)).rejectReports) return
		const objects = activity.objectIds.map((u) => u.href),
			target = objects.length
				? await one<AccountRow>(
						env,
						"SELECT * FROM accounts WHERE domain='' AND (?||'/users/'||username) IN (" +
							objects.map(() => '?').join(',') +
							')',
						env.PUBLIC_ORIGIN,
						...objects
					)
				: null
		if (target) {
			const ids: string[] = []
			for (const uri of objects) {
				const s = await localStatusByUri(env, uri)
				if (s?.account_id === target.id) ids.push(s.id)
			}
			const id = await nextId(env.DB)
			const statements = [
				env.DB.prepare(
					"INSERT INTO reports(id,account_id,target_account_id,comment,category,status_ids,rule_ids,forwarded,created_at,updated_at) VALUES(?,?,?,?,'other',?,'[]',0,?,?)"
				).bind(
					id,
					actor.id,
					target.id,
					String(activity.summary ?? activity.content ?? '').slice(0, 1000),
					JSON.stringify(ids),
					now(),
					now()
				),
			]
			for (const moderator of await all<AccountRow>(
				env,
				"SELECT * FROM accounts WHERE domain='' AND role IN ('admin','moderator')"
			)) {
				const eventKey = 'report:' + id + ':' + moderator.id
				statements.push(
					...(await notificationStatements(env, moderator.id, actor.id, 'admin.report', null, eventKey)),
					env.DB.prepare('UPDATE notifications SET details=? WHERE event_key=?').bind(
						JSON.stringify({ report_id: id }),
						eventKey
					)
				)
			}
			await env.DB.batch(statements)
		}
	} else if (activity instanceof Add || activity instanceof Remove) {
		if (!activity.targetId || activity.targetId.href !== remote.featuredId?.href)
			throw new ApiError(422, 'Featured collection ownership mismatch')
		let s = activity.objectId ? await localStatusByUri(env, activity.objectId.href) : null
		if (!s && activity instanceof Add) {
			const obj = await activity.getObject(loaders)
			if (obj?.attributionId?.href === accountUri(env, actor))
				s = await persistStatus(ctx, obj, actor, 0, { documentLoader })
		}
		if (s && s.account_id === actor.id && ['public', 'unlisted'].includes(s.visibility)) {
			if (activity instanceof Add)
				await run(
					env,
					"INSERT OR IGNORE INTO interactions(id,account_id,status_id,kind,created_at) VALUES(?,?,?,'pin',?)",
					await nextId(env.DB),
					actor.id,
					s.id,
					now()
				)
			else await run(env, "DELETE FROM interactions WHERE account_id=? AND status_id=? AND kind='pin'", actor.id, s.id)
		}
	} else {
		await new D1KvStore(env).set(['unhandled-activity', activity.id.href], serialized)
		throw new ApiError(422, 'Unsupported ActivityPub activity type')
	}
	if (activity instanceof Delete || activity instanceof Announce || activity instanceof Undo) {
		const affected = activity instanceof Announce ? activity.id.href : activity.objectId?.href
		if (affected) {
			const s = await localStatusByUri(env, affected)
			if (s)
				await run(
					env,
					"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'status.event',?,?,?)",
					'incoming-event:' + s.id + ':' + s.revision,
					JSON.stringify({ statusId: s.id }),
					Date.now(),
					Date.now()
				)
		}
	}
	await run(
		env,
		'INSERT OR IGNORE INTO federation_inbox(id,actor_uri,activity,received_at) VALUES(?,?,?,?)',
		activity.id.href,
		activity.actorId.href,
		JSON.stringify(serialized),
		now()
	)
}
export async function localStatusByUri(env: Env, uri: string) {
	return one<StatusRow>(
		env,
		`SELECT s.* FROM statuses s JOIN accounts a ON a.id=s.account_id WHERE s.uri=? OR (a.domain='' AND ?=?||'/users/'||a.username||'/statuses/'||s.id)`,
		uri,
		uri,
		env.PUBLIC_ORIGIN
	)
}

async function receiveVote(ctx: Context<Env>, obj: ASObject, actor: AccountRow, activityId: string) {
	if (!(obj instanceof Note) || !obj.name || !obj.replyTargetId || String(obj.content ?? '')) return false
	const target = await localStatusByUri(ctx.data, obj.replyTargetId.href),
		p = target?.local
			? await one<{ id: string; options: string; multiple: number; expires_at: string }>(
					ctx.data,
					'SELECT * FROM polls WHERE status_id=?',
					target.id
				)
			: null
	if (!target || !p) return false
	if (
		obj.attributionId?.href !== accountUri(ctx.data, actor) ||
		!obj.id ||
		obj.id.origin !== new URL(accountUri(ctx.data, actor)).origin ||
		Date.parse(p.expires_at) <= Date.now() ||
		!(await visible(ctx.data, target, actor.id))
	)
		return true
	const choices = parsed<string[]>(p.options, []),
		choice = choices.indexOf(String(obj.name))
	if (choice < 0) return true
	const mutation = activityId,
		id = await nextId(ctx.data.DB)
	await ctx.data.DB.batch([
		ctx.data.DB.prepare('UPDATE statuses SET revision=revision+1 WHERE id=?').bind(target.id),
		ctx.data.DB.prepare('INSERT OR IGNORE INTO poll_ballots VALUES(?,?,?)').bind(p.id, actor.id, mutation),
		ctx.data.DB.prepare(`INSERT OR IGNORE INTO poll_votes VALUES(?,?,?,?,?)`).bind(id, p.id, actor.id, choice, now()),
	])
	if (!p.multiple)
		await run(
			ctx.data,
			'DELETE FROM poll_votes WHERE poll_id=? AND account_id=? AND id<>(SELECT MIN(id) FROM poll_votes WHERE poll_id=? AND account_id=?)',
			p.id,
			actor.id,
			p.id,
			actor.id
		)
	await run(
		ctx.data,
		"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'status.event',?,?,?)",
		'poll-vote:' + id,
		JSON.stringify({ statusId: target.id }),
		Date.now(),
		Date.now()
	)
	return true
}
