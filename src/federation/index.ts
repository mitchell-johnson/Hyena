import { currentRecipients, filterQueued } from './delivery-policy'
import { domainPolicy } from '../moderation-policy'
import { accountDomain, isLocalAccountDomain } from '../identity'
import { createExponentialBackoffPolicy, createFederationBuilder, type Context, type Message } from '@fedify/fedify'
import { federation as honoFederation } from '@fedify/hono'
import {
	Activity,
	Object as ASObject,
	Person,
	Image,
	Endpoints,
	PropertyValue,
	Create,
	Delete,
	Update,
	Tombstone,
	isActor,
} from '@fedify/vocab'
import type { Context as HonoContext } from 'hono'
import { Temporal as TemporalPolyfill } from '@js-temporal/polyfill'
// Fedify accepts this polyfill at runtime; TypeScript 7's native declarations
// use a wider InstantLike type than polyfill 0.5.1. Isolate that type boundary.
const instant = (value: string) => TemporalPolyfill.Instant.from(value) as unknown as Temporal.Instant
import type { AccountRow, AppEnv, Env, StatusRow } from '../types'
import { accountById, accountUri, all, now, one, parsed, statusUri } from '../data'
import { ApiError } from '../http'
import { actorKeys } from './keys'
import { D1KvStore, D1MessageQueue, type QueueJobLease } from './storage'
import { visible } from '../policy'
import { receive, persistActor } from './receive'
import { activityObject } from './objects'
import { deliverExtension } from './consent'
import { blocked } from '../policy'
import { COLLECTION_CONTEXT } from '../collections'
import { activityOrderingKey, outboundStatement } from './outbox'

export async function actorDocument(env: Env, a: AccountRow) {
	const ctx = (await federation(env)).createContext(new Request(env.PUBLIC_ORIGIN), env),
		actor = await ctx.getActor(a.username)
	if (!actor) throw new ApiError(404, 'Record not found')
	const json = (await actor.toJsonLd()) as Record<string, unknown>
	return {
		...json,
		'@context': [
			...(Array.isArray(json['@context']) ? json['@context'] : [json['@context']]),
			...COLLECTION_CONTEXT.slice(1),
			{
				featuredCollections: { '@id': 'https://www.w3.org/ns/activitystreams#featuredCollections', '@type': '@id' },
				canFeature: { '@id': 'https://w3id.org/fep/7aa9#canFeature', '@type': '@id' },
				interactionPolicy: { '@id': 'https://gotosocial.org/ns#interactionPolicy', '@type': '@id' },
				automaticApproval: { '@id': 'https://gotosocial.org/ns#automaticApproval', '@type': '@id' },
				manualApproval: { '@id': 'https://gotosocial.org/ns#manualApproval', '@type': '@id' },
			},
		],
		featuredCollections: `${accountUri(env, a)}/collections/featured-collections`,
		interactionPolicy: {
			canFeature: {
				automaticApproval: a.discoverable
					? [a.locked ? accountUri(env, a) + '/followers' : 'https://www.w3.org/ns/activitystreams#Public']
					: [],
				manualApproval: [],
			},
		},
	}
}
export async function accountEvent(env: Env, id: string, jobId: string) {
	const a = await accountById(env, id)
	if (a.domain || a.disabled || a.suspended) return
	const recipients = (
		await all<{ id: string }>(env, "SELECT follower_id id FROM follows WHERE following_id=? AND state='accepted'", id)
	).map((r) => r.id)
	if (!recipients.length) return
	await outboundStatement(
		env,
		a.id,
		{ '@context': COLLECTION_CONTEXT, type: 'Update', actor: accountUri(env, a), object: await actorDocument(env, a) },
		recipients,
		jobId
	).run()
}

export const builder = createFederationBuilder<Env>()
const local = (env: Env, username: string) =>
	one<AccountRow>(env, "SELECT * FROM accounts WHERE username=? AND domain=''", username)
builder
	.setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
		const a = await local(ctx.data, identifier)
		if (!a || a.suspended) return null
		const keys = await ctx.getActorKeyPairs(identifier)
		return new Person({
			id: ctx.getActorUri(identifier),
			preferredUsername: a.username,
			name: a.display_name,
			summary: a.note,
			url: new URL(`${ctx.data.PUBLIC_ORIGIN}/@${a.username}`),
			published: instant(a.created_at),
			inbox: ctx.getInboxUri(identifier),
			outbox: ctx.getOutboxUri(identifier),
			followers: ctx.getFollowersUri(identifier),
			following: ctx.getFollowingUri(identifier),
			featured: ctx.getFeaturedUri(identifier),
			endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
			manuallyApprovesFollowers: !!a.locked,
			discoverable: !!a.discoverable,
			indexable: !!a.indexable,
			icon: new Image({ url: new URL(a.avatar || ctx.data.PUBLIC_ORIGIN + '/avatar.svg') }),
			image: new Image({ url: new URL(a.header || ctx.data.PUBLIC_ORIGIN + '/avatar.svg') }),
			publicKey: keys[0]?.cryptographicKey,
			assertionMethods: keys.map((k) => k.multikey),
			attachments: parsed<{ name: string; value: string }[]>(a.fields, []).map(
				(f) => new PropertyValue({ name: f.name, value: f.value })
			),
			aliases: parsed<string[]>(a.aliases, []).map((u) => new URL(u)),
			...(a.moved_to_id
				? { successor: new URL(accountUri(ctx.data, await accountById(ctx.data, a.moved_to_id))) }
				: {}),
		})
	})
	.setKeyPairsDispatcher(async (ctx, identifier) => {
		const a = await local(ctx.data, identifier)
		return a ? actorKeys(ctx.data, a.id) : []
	})

builder.setObjectDispatcher(ASObject, '/users/{identifier}/statuses/{id}', async (ctx, { identifier, id }) => {
	const a = await local(ctx.data, identifier),
		s = await one<StatusRow>(ctx.data, 'SELECT * FROM statuses WHERE id=?', id)
	if (!a || !s || s.account_id !== a.id) return null
	const signer = await ctx.getSignedKeyOwner(),
		viewer = signer?.id
			? ((await one<AccountRow>(ctx.data, 'SELECT * FROM accounts WHERE uri=?', signer.id.href))?.id ?? null)
			: null
	if (s.deleted_at)
		return s.visibility === 'public' || s.visibility === 'unlisted'
			? new Tombstone({ id: new URL(statusUri(ctx.data, s, a)), deleted: instant(s.deleted_at) })
			: null
	if (!(await visible(ctx.data, s, viewer))) return null
	return ASObject.fromJsonLd(await activityObject(ctx.data, s), {
		documentLoader: ctx.documentLoader,
		contextLoader: ctx.contextLoader,
	})
})
builder
	.setOutboxDispatcher('/users/{identifier}/outbox', async (ctx, identifier, cursor) => {
		const a = await local(ctx.data, identifier)
		if (!a) return null
		if (cursor === null) return { items: [], nextCursor: '0' }
		const offset = Number(cursor)
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return null
		const rows = await all<StatusRow>(
			ctx.data,
			"SELECT * FROM statuses WHERE account_id=? AND visibility='public' AND deleted_at IS NULL AND reblog_of_id IS NULL ORDER BY sequence DESC LIMIT 40 OFFSET ?",
			a.id,
			offset
		)
		return {
			items: await Promise.all(
				rows.map(
					async (s) =>
						new Create({
							id: new URL(`${statusUri(ctx.data, s, a)}#create`),
							actor: ctx.getActorUri(identifier),
							object: await ASObject.fromJsonLd(await activityObject(ctx.data, s), ctx),
							published: instant(s.created_at),
						})
				)
			),
			nextCursor: rows.length === 40 ? String(offset + 40) : null,
		}
	})
	.setCounter(
		async (ctx, identifier) =>
			(
				await one<{ n: number }>(
					ctx.data,
					"SELECT COUNT(*) n FROM statuses s JOIN accounts a ON a.id=s.account_id WHERE a.username=? AND a.domain='' AND s.visibility='public' AND s.deleted_at IS NULL",
					identifier
				)
			)?.n ?? 0
	)
	.setFirstCursor(() => '0')
for (const direction of ['followers', 'following'] as const) {
	const register =
		direction === 'followers'
			? builder.setFollowersDispatcher.bind(builder)
			: builder.setFollowingDispatcher.bind(builder)
	register(`/users/{identifier}/${direction}`, async (ctx, identifier, cursor) => {
		const a = await local(ctx.data, identifier)
		if (!a) return null
		const offset = Number(cursor ?? 0)
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return null
		const rows = await all<AccountRow>(
			ctx.data,
			`SELECT a.* FROM follows f JOIN accounts a ON a.id=f.${direction === 'followers' ? 'follower_id' : 'following_id'} WHERE f.${direction === 'followers' ? 'following_id' : 'follower_id'}=? AND f.state='accepted' AND a.suspended=0 ORDER BY f.id LIMIT 40 OFFSET ?`,
			a.id,
			offset
		)
		return {
			items: rows.map(
				(a) =>
					new Person({
						id: new URL(accountUri(ctx.data, a)),
						inbox: a.inbox ? new URL(a.inbox) : new URL(`${accountUri(ctx.data, a)}/inbox`),
						endpoints: new Endpoints({ sharedInbox: a.shared_inbox ? new URL(a.shared_inbox) : null }),
					})
			),
			nextCursor: rows.length === 40 ? String(offset + 40) : null,
		}
	}).setFirstCursor(() => '0')
}
builder.setFeaturedDispatcher('/users/{identifier}/collections/featured', async (ctx, identifier) => {
	const a = await local(ctx.data, identifier)
	if (!a) return null
	const rows = await all<StatusRow>(
		ctx.data,
		"SELECT s.* FROM statuses s JOIN interactions i ON i.status_id=s.id WHERE i.account_id=? AND i.kind='pin' AND s.visibility IN ('public','unlisted') AND s.deleted_at IS NULL",
		a.id
	)
	return {
		items: await Promise.all(rows.map((s) => activityObject(ctx.data, s).then((o) => ASObject.fromJsonLd(o, ctx)))),
	}
})
builder.setNodeInfoDispatcher('/nodeinfo/2.1', async (ctx) => ({
	software: { name: 'hyena', version: '0.2.0', repository: new URL('https://github.com/mitchell-johnson/Hyena') },
	protocols: ['activitypub'],
	services: { inbound: [], outbound: [] },
	openRegistrations: ctx.data.REGISTRATIONS === 'open',
	usage: {
		localComments: 0,
		users: { total: (await one<{ n: number }>(ctx.data, "SELECT COUNT(*) n FROM accounts WHERE domain=''"))?.n ?? 0 },
		localPosts:
			(await one<{ n: number }>(ctx.data, 'SELECT COUNT(*) n FROM statuses WHERE local=1 AND deleted_at IS NULL'))?.n ??
			0,
	},
	metadata: { nodeName: ctx.data.INSTANCE_TITLE, nodeDescription: ctx.data.INSTANCE_DESCRIPTION },
}))
builder.setInboxListeners('/users/{identifier}/inbox', '/inbox').on(Activity, receive)

const outboxRetryPolicy = createExponentialBackoffPolicy({ maxAttempts: Infinity })
export async function federation(env: Env, processing?: QueueJobLease) {
	return builder.build({
		origin: { webOrigin: env.PUBLIC_ORIGIN, handleHost: accountDomain(env) },
		kv: new D1KvStore(env),
		queue: new D1MessageQueue(env, processing),
		// D1 owns the attempt and age limits, including administrator retries.
		// Fedify must not silently abandon a task before the ledger records it.
		outboxRetryPolicy: (context) => outboxRetryPolicy({ ...context, attempts: Math.min(context.attempts, 20) }),
		manuallyStartQueue: true,
		allowPrivateAddress: false,
	})
}
export async function federationMiddleware(c: HonoContext<AppEnv>, next: () => Promise<void>) {
	const url = new URL(c.req.url)
	if (
		c.req.path === '/.well-known/webfinger' &&
		url.origin !== c.env.PUBLIC_ORIGIN &&
		url.host === accountDomain(c.env)
	) {
		return c.redirect(`${c.env.PUBLIC_ORIGIN}${url.pathname}${url.search}`, 307)
	}
	return honoFederation(await federation(c.env), () => c.env)(c, next)
}
export async function federationMessage(env: Env, payload: { message: Message }, processing?: QueueJobLease) {
	const current = await filterQueued(env, payload.message)
	if (current) await (await federation(env, processing)).processQueuedTask(env, current)
}
export async function resolveAccount(env: Env, handle: string, context?: Context<Env>): Promise<AccountRow> {
	const parts = handle.replace(/^@/, '').split('@')
	if (!/^https?:/.test(handle)) {
		const domain = isLocalAccountDomain(env, parts[1]) ? '' : parts[1]!
		const found = await one<AccountRow>(
			env,
			'SELECT * FROM accounts WHERE username=? AND domain=?',
			parts[0] ?? '',
			domain
		)
		if (found) return found
		if (!domain) throw new ApiError(422, 'Mentioned account does not exist')
	}
	const ctx = context ?? (await federation(env)).createContext(new URL(env.PUBLIC_ORIGIN), env),
		actor = await ctx.lookupObject(handle)
	if (!actor || !isActor(actor)) throw new ApiError(422, 'Account could not be resolved')
	return persistActor(ctx, actor)
}
export async function sendStored(
	env: Env,
	payload: { actorId: string; activity: Record<string, unknown>; recipients: string[] }
) {
	const a = await accountById(env, payload.actorId)
	if (a.domain || (a.disabled && !['Delete', 'Undo'].includes(String(payload.activity.type)))) return
	if (/Feature(Request|dCollection|dItem|Authorization)/.test(JSON.stringify(payload.activity))) {
		await deliverExtension(env, payload)
		return
	}
	const f = await federation(env),
		ctx = f.createContext(new URL(env.PUBLIC_ORIGIN), env),
		recipients = []
	for (const id of await currentRecipients(env, payload.activity, [...new Set(payload.recipients)])) {
		const r = await accountById(env, id)
		if (!r.domain || !r.inbox || r.suspended) continue
		if (
			(await blocked(env, a.id, r.id)) &&
			!['Delete', 'Undo', 'Reject', 'Block'].includes(String(payload.activity.type))
		)
			continue
		if (
			await one(
				env,
				"SELECT 1 FROM moderation_rules WHERE kind='domain_blocks' AND value=? AND json_extract(data,'$.severity')='suspend'",
				r.domain
			)
		)
			continue
		recipients.push({
			id: new URL(accountUri(env, r)),
			inboxId: new URL(r.inbox),
			endpoints: { sharedInbox: r.shared_inbox ? new URL(r.shared_inbox) : null },
		})
	}
	if (recipients.length)
		await ctx.sendActivity({ identifier: a.username }, recipients, await Activity.fromJsonLd(payload.activity, ctx), {
			preferSharedInbox: false,
			orderingKey: activityOrderingKey(payload.activity),
			excludeBaseUris: [new URL(env.PUBLIC_ORIGIN)],
		})
}
export async function federateStatus(env: Env, s: StatusRow) {
	if (!s.local) return
	const a = await accountById(env, s.account_id),
		ctx = (await federation(env)).createContext(new URL(env.PUBLIC_ORIGIN), env),
		uri = statusUri(env, s, a)
	const recipients = await all<AccountRow>(
		env,
		`SELECT DISTINCT a.* FROM accounts a WHERE a.domain<>'' AND a.suspended=0 AND (EXISTS(SELECT 1 FROM status_recipients r WHERE r.status_id=? AND r.account_id=a.id) OR (?<>'direct' AND EXISTS(SELECT 1 FROM follows f WHERE f.following_id=? AND f.follower_id=a.id AND f.state='accepted')))`,
		s.id,
		s.visibility,
		s.account_id
	)
	if (!recipients.length) return
	const started = await one<{ federation_started: number }>(
		env,
		'SELECT federation_started FROM statuses WHERE id=?',
		s.id
	)
	const activity = s.deleted_at
		? new Delete({
				id: new URL(`${uri}#delete-${s.revision}`),
				actor: new URL(accountUri(env, a)),
				object: new Tombstone({ id: new URL(uri) }),
			})
		: started?.federation_started
			? new Update({
					id: new URL(`${uri}#update-${s.revision}`),
					actor: new URL(accountUri(env, a)),
					object: await ASObject.fromJsonLd(await activityObject(env, s), ctx),
				})
			: new Create({
					id: new URL(`${uri}#create`),
					actor: new URL(accountUri(env, a)),
					object: await ASObject.fromJsonLd(await activityObject(env, s), ctx),
				})
	await env.DB.batch([
		outboundStatement(
			env,
			a.id,
			(await activity.toJsonLd()) as Record<string, unknown>,
			recipients.map((a) => a.id),
			`status-${s.id}-${s.revision}`
		),
		env.DB.prepare('UPDATE statuses SET federation_started=1 WHERE id=?').bind(s.id),
	])
}
