import { currentRecipients } from './delivery-policy'
import { domainPolicy } from '../moderation-policy'
import { Hono } from 'hono'
import { getKeyOwner, verifyRequest, signRequest, type Context } from '@fedify/fedify'
import { Object as ASObject, isActor } from '@fedify/vocab'
import { validatePublicUrl } from '@fedify/vocab-runtime'
import type { Context as HonoContext } from 'hono'
import { accountById, accountUri, all, now, one, parsed, run, statusUri, object } from '../data'
import { ApiError, boundedBytes } from '../http'
import { nextId } from '../db'
import { blocked, visible } from '../policy'
import { notificationStatements } from '../notifications'
import {
	COLLECTION_CONTEXT,
	canFeature,
	collectionChanged,
	collectionUri,
	featuredCollection,
	featuredItem,
	loadCollection,
	type CollectionRow,
	type ItemRow,
} from '../collections'
import type { AccountRow, AppEnv, Env, StatusRow } from '../types'
import { federation, actorDocument } from './index'
import { persistActor, persistStatus, localStatusByUri, cleanHtml, safeUrl } from './receive'
import { outboundStatement } from './outbox'

export const QUOTE_CONTEXT = [
	'https://www.w3.org/ns/activitystreams',
	{
		QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest',
		QuoteAuthorization: 'https://w3id.org/fep/044f#QuoteAuthorization',
		quote: { '@id': 'https://w3id.org/fep/044f#quote', '@type': '@id' },
		quoteAuthorization: { '@id': 'https://w3id.org/fep/044f#quoteAuthorization', '@type': '@id' },
		interactingObject: { '@id': 'https://gotosocial.org/ns#interactingObject', '@type': '@id' },
		interactionTarget: { '@id': 'https://gotosocial.org/ns#interactionTarget', '@type': '@id' },
	},
]
export const uriOf = (v: unknown): string | null =>
	typeof v === 'string'
		? v
		: v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>).id === 'string'
			? (v as { id: string }).id
			: Array.isArray(v)
				? uriOf(v[0])
				: null
const localActor = (env: Env, uri: string) =>
	one<AccountRow>(
		env,
		"SELECT * FROM accounts WHERE domain='' AND (uri=? OR ?=?||'/users/'||username)",
		uri,
		uri,
		env.PUBLIC_ORIGIN
	)
const sameHost = (a: string, b: string) => {
	try {
		return new URL(a).origin === new URL(b).origin
	} catch {
		return false
	}
}
export async function fetchCollection(
	ctx: Context<Env>,
	uri: string,
	owner: AccountRow,
	prefetched?: Record<string, unknown>
): Promise<CollectionRow> {
	if (!sameHost(uri, accountUri(ctx.data, owner)))
		throw new ApiError(422, 'Collection identity must belong to its owner')
	const json = prefetched ?? object((await ctx.documentLoader(uri)).document)
	if (json.type !== 'FeaturedCollection' || uriOf(json.attributedTo) !== accountUri(ctx.data, owner) || json.id !== uri)
		throw new ApiError(422, 'Invalid collection owner')
	const old = await one<CollectionRow>(ctx.data, 'SELECT * FROM collections WHERE uri=?', uri)
	if (old?.deleted_at) throw new ApiError(422, 'Collection was deleted')
	const id = old?.id ?? (await nextId(ctx.data.DB)),
		summaryMap =
			json.summaryMap && typeof json.summaryMap === 'object' ? Object.entries(json.summaryMap)[0] : undefined,
		description = cleanHtml(String(json.summary ?? summaryMap?.[1] ?? '')).slice(0, 2048),
		name = String(json.name ?? '').slice(0, 256)
	if (!name) throw new ApiError(422, 'Collection name is missing')
	await run(
		ctx.data,
		`INSERT INTO collections(id,account_id,uri,name,description,discoverable,sensitive,language,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uri) DO UPDATE SET name=excluded.name,description=excluded.description,discoverable=excluded.discoverable,sensitive=excluded.sensitive,language=excluded.language,updated_at=excluded.updated_at WHERE collections.account_id=excluded.account_id`,
		id,
		owner.id,
		uri,
		name,
		description,
		+(json.discoverable === true),
		+(json.sensitive === true),
		summaryMap?.[0] ?? null,
		String(json.published ?? now()),
		String(json.updated ?? now())
	)
	const c = (await one<CollectionRow>(ctx.data, 'SELECT * FROM collections WHERE id=?', id))!
	const items = Array.isArray(json.orderedItems) ? json.orderedItems.slice(0, 25) : [],
		present: string[] = []
	for (const raw of items) {
		if (!raw || typeof raw !== 'object') continue
		const i = raw as Record<string, unknown>,
			actorUri = uriOf(i.featuredObject),
			authorization = uriOf(i.featureAuthorization),
			itemId = uriOf(i)
		if (actorUri) present.push(actorUri)
		if (i.type !== 'FeaturedItem' || !actorUri || !authorization || !itemId || !sameHost(itemId, uri)) continue
		const targetObject = await ctx.lookupObject(actorUri)
		if (!targetObject || !isActor(targetObject)) continue
		const target = await persistActor(ctx, targetObject)
		if (await blocked(ctx.data, owner.id, target.id)) continue
		const existing = await one<ItemRow>(
			ctx.data,
			'SELECT * FROM collection_items WHERE collection_id=? AND account_id=?',
			id,
			target.id
		)
		if (existing?.state === 'revoked') continue
		if (target.domain) {
			if (!sameHost(authorization, actorUri)) continue
			const proof = object((await ctx.documentLoader(authorization)).document)
			if (
				proof.type !== 'FeatureAuthorization' ||
				proof.id !== authorization ||
				uriOf(proof.interactionTarget) !== actorUri ||
				uriOf(proof.interactingObject) !== uri
			)
				continue
		} else if (!existing || existing.state !== 'accepted' || existing.authorization !== authorization) continue
		await run(
			ctx.data,
			`INSERT INTO collection_items(id,collection_id,account_id,state,authorization,created_at,request_uri) VALUES(?,?,?,'accepted',?,?,?) ON CONFLICT(collection_id,account_id) DO UPDATE SET state='accepted',authorization=excluded.authorization WHERE collection_items.state<>'revoked'`,
			existing?.id ?? (await nextId(ctx.data.DB)),
			id,
			target.id,
			authorization,
			String(i.published ?? now()),
			itemId
		)
	}
	if (Array.isArray(json.orderedItems))
		await run(
			ctx.data,
			`UPDATE collection_items SET state='rejected' WHERE collection_id=? AND state='accepted' AND account_id NOT IN (SELECT id FROM accounts WHERE COALESCE(uri,?||'/users/'||username) IN (${present.map(() => '?').join(',') || 'NULL'}))`,
			id,
			ctx.data.PUBLIC_ORIGIN,
			...present
		)
	return c
}
export async function consentActivity(
	ctx: Context<Env>,
	json: Record<string, unknown>,
	actor: AccountRow
): Promise<boolean> {
	const env = ctx.data,
		id = uriOf(json),
		actorURI = accountUri(env, actor),
		objectURI = uriOf(json.object),
		type = json.type
	if (!id) throw new ApiError(422, 'Missing activity identity')
	if (type === 'QuoteRequest') {
		if (!sameHost(id, actorURI) || !objectURI) return true
		const target = await localStatusByUri(env, objectURI),
			quoteURI = uriOf(json.instrument)
		if (
			!target?.local ||
			!quoteURI ||
			!sameHost(quoteURI, actorURI) ||
			!['public', 'unlisted'].includes(target.visibility) ||
			target.reblog_of_id
		)
			return true
		const owner = await accountById(env, target.account_id),
			follows = await one(
				env,
				"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
				actor.id,
				owner.id
			),
			allowed =
				(await visible(env, target, actor.id)) &&
				(target.quote_policy === 'public' ||
					(target.quote_policy === 'followers' && !!follows) ||
					actor.id === owner.id)
		let quote = await localStatusByUri(env, quoteURI)
		if (!quote) {
			const raw =
					json.instrument && typeof json.instrument === 'object'
						? { ...object(json.instrument), '@context': json['@context'] }
						: null,
				obj = raw ? await ASObject.fromJsonLd(raw, ctx) : await ctx.lookupObject(quoteURI)
			if (obj) quote = await persistStatus(ctx, obj, actor)
		}
		if (!quote || quote.account_id !== actor.id || quote.quote_id !== target.id)
			throw new ApiError(422, 'Quote request instrument does not quote its target')
		const authorization = `${env.PUBLIC_ORIGIN}/quote_authorizations/${quote.id}`
		await env.DB.batch([
			env.DB.prepare('INSERT OR IGNORE INTO quote_requests VALUES(?,?,?,?,?,?,?,?)').bind(
				id,
				actor.id,
				target.id,
				quoteURI,
				allowed ? authorization : null,
				allowed ? 'accepted' : 'rejected',
				now()
			),
			env.DB.prepare('UPDATE statuses SET quote_state=?,quote_authorization=? WHERE id=?').bind(
				allowed ? 'accepted' : 'rejected',
				allowed ? authorization : null,
				quote.id
			),
			outboundStatement(
				env,
				owner.id,
				{
					'@context': QUOTE_CONTEXT,
					type: allowed ? 'Accept' : 'Reject',
					actor: accountURIFor(owner, env),
					object: json,
					...(allowed ? { result: authorization } : {}),
				},
				[actor.id],
				'quote-response-' + quote.id
			),
			...(allowed ? await notificationStatements(env, owner.id, actor.id, 'quote', quote.id, 'quote:' + quote.id) : []),
		])
		return true
	}
	if (type === 'FeatureRequest') {
		const target = objectURI ? await localActor(env, objectURI) : null,
			uri = uriOf(json.instrument)
		if (!target || !uri || !sameHost(id, actorURI)) return true
		const c = await fetchCollection(ctx, uri, actor),
			allowed = await canFeature(env, actor, target),
			old = await one<ItemRow>(
				env,
				'SELECT * FROM collection_items WHERE collection_id=? AND account_id=?',
				c.id,
				target.id
			),
			itemId = old?.id ?? (await nextId(env.DB)),
			authorization = `${env.PUBLIC_ORIGIN}/feature_authorizations/${itemId}`
		const accepted = allowed && old?.state !== 'revoked'
		await env.DB.batch([
			env.DB.prepare('INSERT OR IGNORE INTO feature_requests VALUES(?,?,?,?,?,?,?,?)').bind(
				id,
				actor.id,
				target.id,
				uri,
				accepted ? authorization : null,
				accepted ? 'accepted' : 'rejected',
				now()
			),
			env.DB.prepare(
				`INSERT INTO collection_items(id,collection_id,account_id,state,authorization,created_at,request_uri) VALUES(?,?,?,?,?,?,?) ON CONFLICT(collection_id,account_id) DO UPDATE SET state=excluded.state,authorization=excluded.authorization,request_uri=excluded.request_uri WHERE collection_items.state<>'revoked'`
			).bind(itemId, c.id, target.id, accepted ? 'accepted' : 'rejected', accepted ? authorization : null, now(), id),
			outboundStatement(
				env,
				target.id,
				{
					'@context': COLLECTION_CONTEXT,
					type: accepted ? 'Accept' : 'Reject',
					actor: accountUri(env, target),
					object: id,
					...(accepted ? { result: authorization } : {}),
				},
				[actor.id],
				'feature-response-' + itemId
			),
			...(accepted
				? await notificationStatements(
						env,
						target.id,
						actor.id,
						'added_to_collection',
						null,
						'collection-item:' + itemId,
						undefined,
						c.id
					)
				: []),
		])
		return true
	}
	if ((type === 'Accept' || type === 'Reject') && objectURI) {
		const i = await one<ItemRow>(
			env,
			'SELECT * FROM collection_items WHERE request_uri=? AND account_id=?',
			objectURI,
			actor.id
		)
		const q = await one<StatusRow>(
			env,
			"SELECT s.* FROM statuses s JOIN statuses t ON t.id=s.quote_id WHERE s.local=1 AND s.quote_state='pending' AND t.account_id=? AND ?=?||'/activities/quote-'||s.id",
			actor.id,
			objectURI,
			env.PUBLIC_ORIGIN
		)
		if (!i && !q) return false
		const authorization = uriOf(json.result)
		if (type === 'Accept' && (!authorization || !sameHost(authorization, actorURI)))
			throw new ApiError(422, 'Approval identity must belong to the approving author')
		if (i) {
			await run(
				env,
				"UPDATE collection_items SET state=?,authorization=? WHERE id=? AND state='pending'",
				type === 'Accept' ? 'accepted' : 'rejected',
				authorization,
				i.id
			)
			const c = await one<CollectionRow>(env, 'SELECT * FROM collections WHERE id=?', i.collection_id)
			if (c) await (await collectionChanged(env, c)).run()
		}
		if (q) {
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE statuses SET quote_state=?,quote_authorization=?,revision=revision+1 WHERE id=? AND quote_state='pending'"
				).bind(type === 'Accept' ? 'accepted' : 'rejected', authorization, q.id),
				env.DB.prepare(
					"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'status.event',?,?,?)"
				).bind('quote-approved:' + q.id, JSON.stringify({ statusId: q.id }), Date.now(), Date.now()),
			])
		}
		return true
	}
	if (type === 'Delete' && objectURI) {
		const q = await one<StatusRow>(
				env,
				'SELECT s.* FROM statuses s JOIN statuses t ON t.id=s.quote_id WHERE s.quote_authorization=? AND t.account_id=?',
				objectURI,
				actor.id
			),
			i = await one<ItemRow>(
				env,
				'SELECT * FROM collection_items WHERE authorization=? AND account_id=?',
				objectURI,
				actor.id
			)
		if (q) {
			await env.DB.batch([
				env.DB.prepare("UPDATE statuses SET quote_state='revoked',revision=revision+1 WHERE id=?").bind(q.id),
				env.DB.prepare(
					"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'status.event',?,?,?)"
				).bind('quote-revoked:' + q.id, JSON.stringify({ statusId: q.id }), Date.now(), Date.now()),
			])
			return true
		}
		if (i) {
			await run(env, "UPDATE collection_items SET state='revoked' WHERE id=?", i.id)
			return true
		}
		const c = await one<CollectionRow>(
			env,
			'SELECT * FROM collections WHERE uri=? AND account_id=?',
			objectURI,
			actor.id
		)
		if (c) {
			await run(env, 'UPDATE collections SET deleted_at=? WHERE id=?', now(), c.id)
			return true
		}
	}
	if (['Add', 'Update', 'Create', 'Remove'].includes(String(type))) {
		const obj = json.object && typeof json.object === 'object' ? object(json.object) : null,
			targetURI = uriOf(json.target)
		if (obj?.type === 'FeaturedCollection' && objectURI) {
			await fetchCollection(ctx, objectURI, actor, obj)
			return true
		}
		if (targetURI) {
			const c = await one<CollectionRow>(
				env,
				'SELECT * FROM collections WHERE uri=? AND account_id=?',
				targetURI,
				actor.id
			)
			if (c) {
				if (type === 'Remove' && objectURI)
					await run(
						env,
						"UPDATE collection_items SET state='rejected' WHERE collection_id=? AND request_uri=?",
						c.id,
						objectURI
					)
				else await fetchCollection(ctx, targetURI, actor)
				return true
			}
		}
	}
	return false
}
const accountURIFor = (a: AccountRow, env: Env) => accountUri(env, a)

// Fedify 2.3 handles standard activities and quotes. Preserve the FEP-7aa9
// JSON for types outside its generated vocabulary, while using its HTTP
// signature verifier, key ownership checks and restricted document loader.
export async function extensionInbox(c: HonoContext<AppEnv>, next: () => Promise<void>) {
	if (c.req.method !== 'POST' || !/(?:\/users\/[^/]+)?\/inbox$/.test(c.req.path)) return next()
	const bytes = await boundedBytes(c.req.raw.clone(), 1_000_000),
		text = new TextDecoder().decode(bytes)
	if (!/"(?:FeatureRequest|FeaturedCollection|FeaturedItem|FeatureAuthorization)"/.test(text)) return next()
	let json: Record<string, unknown>
	try {
		json = object(JSON.parse(text))
	} catch {
		throw new ApiError(400, 'Invalid activity JSON')
	}
	const ctx = (await federation(c.env)).createContext(new URL(c.env.PUBLIC_ORIGIN), c.env),
		key = await verifyRequest(c.req.raw, {
			documentLoader: ctx.documentLoader,
			contextLoader: ctx.contextLoader,
			spec: c.req.header('Signature-Input') ? 'rfc9421' : 'draft-cavage-http-signatures-12',
			timeWindow: { minutes: 5 },
		})
	if (!key) throw new ApiError(401, 'Invalid activity signature')
	const owner = await getKeyOwner(key, ctx),
		actor = uriOf(json.actor),
		id = uriOf(json)
	if (
		!owner?.id ||
		!actor ||
		owner.id.href !== actor ||
		!id ||
		!sameHost(id, actor) ||
		sameHost(actor, c.env.PUBLIC_ORIGIN)
	)
		throw new ApiError(403, 'Signature does not belong to the activity actor')
	const a = await persistActor(ctx, owner)
	await run(
		c.env,
		"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'federation.extension',?,?,?)",
		'extension:' +
			(await crypto.subtle
				.digest('SHA-256', new TextEncoder().encode(id))
				.then((b) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join(''))),
		JSON.stringify({ actorId: a.id, activity: json, orderingKey: 'inbox:' + a.id }),
		Date.now(),
		Date.now()
	)
	return c.body(null, 202)
}
export async function receiveExtension(env: Env, payload: { actorId: string; activity: Record<string, unknown> }) {
	const id = uriOf(payload.activity)
	if (!id || (await one(env, 'SELECT 1 FROM federation_inbox WHERE id=?', id))) return
	const ctx = (await federation(env)).createContext(new URL(env.PUBLIC_ORIGIN), env),
		actor = await accountById(env, payload.actorId)
	if (actor.suspended) return
	if (!(await consentActivity(ctx, payload.activity, actor))) throw new ApiError(422, 'Unknown collection activity')
	await run(
		env,
		'INSERT OR IGNORE INTO federation_inbox VALUES(?,?,?,?)',
		id,
		accountUri(env, actor),
		JSON.stringify(payload.activity),
		now()
	)
}
export async function deliverExtension(
	env: Env,
	payload: { actorId: string; activity: Record<string, unknown>; recipients: string[] }
) {
	const ctx = (await federation(env)).createContext(new URL(env.PUBLIC_ORIGIN), env),
		a = await accountById(env, payload.actorId),
		keys = await ctx.getActorKeyPairs(a.username),
		id = uriOf(payload.activity)
	if (!id || !keys[0]) throw new ApiError(422, 'Activity identity or signing key missing')
	const inboxes = new Set<string>()
	for (const target of await currentRecipients(env, payload.activity, payload.recipients)) {
		const r = await accountById(env, target)
		if (
			!r.domain ||
			!r.inbox ||
			r.suspended ||
			((await blocked(env, a.id, r.id)) && !['Delete', 'Undo', 'Reject'].includes(String(payload.activity.type)))
		)
			continue
		inboxes.add(r.inbox)
	}
	for (const inbox of inboxes) {
		if (await one(env, 'SELECT 1 FROM delivery_receipts WHERE activity_id=? AND inbox=?', id, inbox)) continue
		await validatePublicUrl(inbox)
		let response: Response | undefined
		for (const spec of ['rfc9421', 'draft-cavage-http-signatures-12'] as const) {
			const request = await signRequest(
				new Request(inbox, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/activity+json',
						'User-Agent': 'Hyena/0.2 (+https://github.com/mitchell-johnson/Hyena)',
					},
					body: JSON.stringify(payload.activity),
					redirect: 'manual',
					signal: AbortSignal.timeout(15000),
				}),
				keys[0].privateKey,
				keys[0].keyId,
				{ spec }
			)
			response = await fetch(request)
			if (![400, 401, 403].includes(response.status)) break
		}
		if (response?.ok || response?.status === 410 || response?.status === 404)
			await run(env, 'INSERT OR IGNORE INTO delivery_receipts VALUES(?,?,?)', id, inbox, now())
		else throw new Error('Collection delivery failed')
	}
}
export const protocol = new Hono<AppEnv>()
const apHeaders = { 'Content-Type': 'application/activity+json', 'Cache-Control': 'no-store' }
protocol.get('/users/:username', async (c, next) => {
	if (!/application\/(?:activity\+json|ld\+json)/.test(c.req.header('Accept') ?? '')) return next()
	const a = await one<AccountRow>(
		c.env,
		"SELECT * FROM accounts WHERE username=? AND domain='' AND suspended=0",
		c.req.param('username')
	)
	if (!a) throw new ApiError(404, 'Record not found')
	return c.json(await actorDocument(c.env, a), 200, apHeaders)
})
protocol.get('/collections/:id', async (c, next) => {
	if (/text\/html/.test(c.req.header('Accept') ?? '')) return next()
	return c.json(await featuredCollection(c.env, await loadCollection(c.env, c.req.param('id'), null)), 200, apHeaders)
})
protocol.get('/collections/:id/items/:item', async (c) => {
	await loadCollection(c.env, c.req.param('id'), null)
	const i = await one<ItemRow>(
		c.env,
		"SELECT * FROM collection_items WHERE id=? AND collection_id=? AND state='accepted'",
		c.req.param('item'),
		c.req.param('id')
	)
	if (!i) throw new ApiError(404, 'Record not found')
	return c.json({ '@context': COLLECTION_CONTEXT, ...(await featuredItem(c.env, i)) }, 200, apHeaders)
})
protocol.get('/users/:username/collections/featured-collections', async (c) => {
	const a = await one<AccountRow>(
		c.env,
		"SELECT * FROM accounts WHERE domain='' AND username=? AND suspended=0",
		c.req.param('username')
	)
	if (!a) throw new ApiError(404, 'Record not found')
	const rows = await all<CollectionRow>(
		c.env,
		'SELECT * FROM collections WHERE account_id=? AND deleted_at IS NULL ORDER BY id',
		a.id
	)
	return c.json(
		{
			'@context': COLLECTION_CONTEXT,
			id: c.req.url,
			type: 'OrderedCollection',
			totalItems: rows.length,
			orderedItems: await Promise.all(rows.map((r) => featuredCollection(c.env, r))),
		},
		200,
		apHeaders
	)
})
protocol.get('/quote_authorizations/:id', async (c) => {
	const q = await one<StatusRow>(
			c.env,
			"SELECT * FROM statuses WHERE id=? AND quote_state='accepted' AND deleted_at IS NULL",
			c.req.param('id')
		),
		s = q?.quote_id ? await one<StatusRow>(c.env, 'SELECT * FROM statuses WHERE id=?', q.quote_id) : null
	if (
		!q ||
		!s?.local ||
		s.deleted_at ||
		!['public', 'unlisted'].includes(s.visibility) ||
		(await blocked(c.env, q.account_id, s.account_id))
	)
		throw new ApiError(404, 'Record not found')
	return c.json(
		{
			'@context': QUOTE_CONTEXT,
			id: c.req.url,
			type: 'QuoteAuthorization',
			attributedTo: accountUri(c.env, await accountById(c.env, s.account_id)),
			interactingObject: statusUri(c.env, q, await accountById(c.env, q.account_id)),
			interactionTarget: statusUri(c.env, s, await accountById(c.env, s.account_id)),
		},
		200,
		apHeaders
	)
})
protocol.get('/feature_authorizations/:id', async (c) => {
	const i = await one<ItemRow>(
		c.env,
		"SELECT * FROM collection_items WHERE id=? AND state='accepted'",
		c.req.param('id')
	)
	if (!i) throw new ApiError(404, 'Record not found')
	const a = await accountById(c.env, i.account_id),
		row = await loadCollection(c.env, i.collection_id, null)
	if (a.domain || !(await canFeature(c.env, await accountById(c.env, row.account_id), a)))
		throw new ApiError(404, 'Record not found')
	return c.json(
		{
			'@context': COLLECTION_CONTEXT,
			id: c.req.url,
			type: 'FeatureAuthorization',
			interactingObject: collectionUri(c.env, row),
			interactionTarget: accountUri(c.env, a),
		},
		200,
		apHeaders
	)
})
protocol.get('/activities/:id', async (c) => {
	const job = await one<{ payload: string }>(
		c.env,
		"SELECT payload FROM jobs WHERE id=? AND kind='federation.send'",
		'outbound:' + c.req.param('id')
	)
	if (!job) throw new ApiError(404, 'Record not found')
	const payload = parsed<{ actorId: string; activity: Record<string, unknown>; recipients?: string[] }>(job.payload, {
			actorId: '',
			activity: {},
		}),
		activity = payload.activity,
		type = String(activity.type)
	if (['Create', 'Update', 'Delete', 'Announce'].includes(type))
		throw new ApiError(404, 'Use the canonical status resource')
	const ctx = (await federation(c.env)).createContext(c.req.raw, c.env),
		owner = await ctx.getSignedKeyOwner()
	if (!owner?.id) throw new ApiError(401, 'A signed request is required')
	const signer = await one<AccountRow>(c.env, 'SELECT * FROM accounts WHERE uri=?', owner.id.href)
	if (!signer || !payload.recipients?.includes(signer.id)) throw new ApiError(404, 'Record not found')
	return c.json(activity, 200, apHeaders)
})
