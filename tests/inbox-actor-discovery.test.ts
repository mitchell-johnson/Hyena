import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { verifyRequest, type InboxContext, type Message } from '@fedify/fedify'
import { Accept, Activity, Announce, Collection, Create, Hashtag, Image, Note, Person, Question } from '@fedify/vocab'
import { Temporal } from '@js-temporal/polyfill'
import { federation } from '../src/federation'
import { persistActor, persistStatus, receive } from '../src/federation/receive'
import { D1MessageQueue } from '../src/federation/storage'
import { executeJob } from '../src/jobs'
import { all, one, run } from '../src/data'
import type { Env, JobRow, StatusRow } from '../src/types'
import { env, runtime, seed, json } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

async function secureActor() {
	const local = await seed('alice'),
		ctx = (await federation(env)).createContext(new Request(env.PUBLIC_ORIGIN), env),
		localDocument = await (await ctx.getActor('alice'))!.toJsonLd(),
		// All requests are mocked; using a public IP also avoids DNS requests.
		actor = new Person({
			id: new URL('https://1.1.1.1/users/bob'),
			preferredUsername: 'bob',
			inbox: new URL('https://1.1.1.1/inbox'),
		}),
		remote = await persistActor(ctx, actor),
		document = await actor.toJsonLd(),
		documents = new Map<string, unknown>([[actor.id!.href, document]]),
		requests: { signed: boolean; owner: string | null }[] = [],
		requestedUrls: string[] = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		if (!documents.has(request.url)) throw new Error('Unexpected federation request')
		const key = await verifyRequest(request.clone(), {
			documentLoader: async (url) => ({ contextUrl: null, documentUrl: url, document: localDocument }),
		})
		requests.push({ signed: !!key, owner: key?.ownerId?.href ?? null })
		requestedUrls.push(request.url)
		return key
			? Response.json(documents.get(request.url), { headers: { 'Content-Type': 'application/activity+json' } })
			: new Response('Signed actor request required', { status: 401 })
	})
	return { local, ctx, actor, remote, requests, documents, requestedUrls }
}

async function queueActivity(activity: Activity, identifier: string | null = null) {
	const message: Message = {
		type: 'inbox',
		id: crypto.randomUUID(),
		baseUrl: env.PUBLIC_ORIGIN,
		activity: await activity.toJsonLd(),
		started: new Date().toISOString(),
		attempt: 0,
		identifier,
		traceContext: {},
	}
	// This is the durable message produced after Fedify accepts an inbox request.
	await new D1MessageQueue(env).enqueue(message)
	return (await one<JobRow>(env, "SELECT * FROM jobs WHERE json_extract(payload,'$.activityId')=?", activity.id!.href))!
}

it('recovers an older shared-inbox Create before a newer Accept by signing as the pending local follower', async () => {
	const { local, actor, remote, requests } = await secureActor(),
		note = new Note({
			id: new URL('https://1.1.1.1/posts/older'),
			attribution: actor.id,
			content: '<p>An older public post</p>',
			published: Temporal.Instant.fromEpochMilliseconds(
				Date.now() - 86400000
			) as unknown as globalThis.Temporal.Instant,
			to: new URL('https://www.w3.org/ns/activitystreams#Public'),
		}),
		create = new Create({ id: new URL('https://1.1.1.1/activities/older'), actor: actor.id, object: note }),
		older = await queueActivity(create)
	vi.spyOn(console, 'error').mockImplementation(() => {})
	await executeJob(env, older.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', older.id)).toMatchObject({
		state: 'pending',
		attempt: 1,
	})
	expect(requests.some((request) => !request.signed)).toBe(true)
	expect(await one(env, 'SELECT id FROM statuses WHERE uri=?', note.id!.href)).toBeNull()
	await json(`/api/v1/accounts/${remote.id}/follow`, { token: local.token, method: 'POST', body: {} })
	const follow = (await one<{ activity_uri: string }>(
			env,
			'SELECT activity_uri FROM follows WHERE follower_id=? AND following_id=?',
			local.id,
			remote.id
		))!,
		accept = new Accept({
			id: new URL('https://1.1.1.1/activities/accept'),
			actor: actor.id,
			object: new URL(follow.activity_uri),
		}),
		newer = await queueActivity(accept),
		requestCount = requests.length
	await executeJob(env, newer.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', newer.id)).toMatchObject({
		state: 'pending',
		completed_at: null,
	})
	expect(requests).toHaveLength(requestCount)
	for (const job of [older, newer]) {
		await run(env, 'UPDATE jobs SET available_at=? WHERE id=?', Date.now(), job.id)
		await executeJob(env, job.id)
		expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', job.id)).toMatchObject({
			state: 'done',
			last_error: null,
		})
	}
	expect(await one(env, 'SELECT content FROM statuses WHERE uri=?', note.id!.href)).toEqual({
		content: '<p>An older public post</p>',
	})
	expect(
		await one(env, 'SELECT state FROM follows WHERE follower_id=? AND following_id=?', local.id, remote.id)
	).toEqual({ state: 'accepted' })
	expect(await all(env, 'SELECT id FROM federation_inbox')).toHaveLength(2)
	expect(requests.slice(requestCount)).toEqual([
		{ signed: true, owner: env.PUBLIC_ORIGIN + '/users/alice' },
		{ signed: true, owner: env.PUBLIC_ORIGIN + '/users/alice' },
	])
})

it('rejects cross-origin activity IDs before fetching or persisting their actor', async () => {
	const { ctx, actor, requests } = await secureActor()
	await expect(
		receive(
			ctx as unknown as InboxContext<Env>,
			new Accept({
				id: new URL('https://attacker.example/activities/spoofed'),
				actor: actor.id,
				object: new URL(env.PUBLIC_ORIGIN + '/activities/unknown'),
			})
		)
	).rejects.toThrow('An activity needs a stable ID and actor')
	expect(requests).toHaveLength(0)
	expect(await all(env, 'SELECT id FROM federation_inbox')).toHaveLength(0)
})

it('signs a referenced Create and its protected reply, hashtag, media, poll options and vote counts', async () => {
	const { local, actor, remote, documents, requests, requestedUrls } = await secureActor(),
		uri = (path: string) => new URL('https://1.1.1.1/' + path),
		parent = new Note({ id: uri('posts/parent'), attribution: actor.id, content: 'Parent', to: uri('public') }),
		image = new Image({ id: uri('media/document'), url: uri('media/photo.jpg'), mediaType: 'image/jpeg' }),
		tag = new Hashtag({ id: uri('tags/document'), name: '#hyena', href: uri('tags/hyena') }),
		counts = [
			new Collection({ id: uri('poll/yes/votes'), totalItems: 3 }),
			new Collection({ id: uri('poll/no/votes'), totalItems: 2 }),
		],
		choices = [
			new Note({ id: uri('poll/yes'), name: 'Yes', replies: counts[0]!.id }),
			new Note({ id: uri('poll/no'), name: 'No', replies: counts[1]!.id }),
		],
		question = new Question({
			id: uri('posts/poll'),
			attribution: actor.id,
			content: '<p>Working?</p>',
			to: new URL('https://www.w3.org/ns/activitystreams#Public'),
			replyTarget: parent.id,
			attachments: [image.id!],
			tags: [tag.id!],
			exclusiveOptions: choices.map((choice) => choice.id!),
		})
	for (const object of [parent, image, tag, ...counts, ...choices, question])
		documents.set(object.id!.href, await object.toJsonLd())
	await json(`/api/v1/accounts/${remote.id}/follow`, { token: local.token, method: 'POST', body: {} })
	const create = new Create({ id: uri('activities/poll'), actor: actor.id, object: question.id }),
		job = await queueActivity(create)
	await executeJob(env, job.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', job.id)).toMatchObject({ state: 'done' })
	const saved = (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE uri=?', question.id!.href))!
	expect(saved.in_reply_to_id).not.toBeNull()
	expect(await one(env, 'SELECT tag FROM status_tags WHERE status_id=?', saved.id)).toEqual({ tag: 'hyena' })
	expect(await one(env, 'SELECT remote_url FROM media_attachments WHERE status_id=?', saved.id)).toEqual({
		remote_url: image.url!.href,
	})
	expect(await one(env, 'SELECT options,remote_votes FROM polls WHERE status_id=?', saved.id)).toEqual({
		options: '["Yes","No"]',
		remote_votes: '[3,2]',
	})
	for (const object of [actor, parent, image, tag, ...counts, ...choices, question])
		expect(requestedUrls).toContain(object.id!.href)
	expect(requests.every((request) => request.signed && request.owner === env.PUBLIC_ORIGIN + '/users/alice')).toBe(true)
})

it('signs a boost target and its author, then enqueues one live event across repeated delivery', async () => {
	const { local, actor, remote, documents, requests } = await secureActor(),
		author = new Person({
			id: new URL('https://1.1.1.1/users/carol'),
			preferredUsername: 'carol',
			inbox: new URL('https://1.1.1.1/inbox/carol'),
		}),
		note = new Note({
			id: new URL('https://1.1.1.1/posts/boosted'),
			attribution: author.id,
			content: '<p>A boosted post</p>',
			to: new URL('https://www.w3.org/ns/activitystreams#Public'),
		})
	for (const object of [author, note]) documents.set(object.id!.href, await object.toJsonLd())
	await json(`/api/v1/accounts/${remote.id}/follow`, { token: local.token, method: 'POST', body: {} })
	const boost = new Announce({
		id: new URL('https://1.1.1.1/activities/boost'),
		actor: actor.id,
		object: note.id,
	})
	for (let attempt = 0; attempt < 2; attempt++) {
		const job = await queueActivity(boost)
		await executeJob(env, job.id)
		expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', job.id)).toMatchObject({ state: 'done' })
	}
	const saved = (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE uri=?', boost.id!.href))!
	expect(saved.reblog_of_id).not.toBeNull()
	expect(
		await all(env, "SELECT id FROM jobs WHERE kind='status.event' AND json_extract(payload,'$.statusId')=?", saved.id)
	).toHaveLength(1)
	expect(requests.every((request) => request.signed && request.owner === env.PUBLIC_ORIGIN + '/users/alice')).toBe(true)
})

it('quietly stores historical replies and quotes without streams or mention notifications', async () => {
	const { local, ctx, actor, remote, documents, requests } = await secureActor(),
		to = [new URL('https://www.w3.org/ns/activitystreams#Public'), new URL(env.PUBLIC_ORIGIN + '/users/alice')],
		parent = new Note({
			id: new URL('https://1.1.1.1/posts/quiet-parent'),
			attribution: actor.id,
			content: 'Parent',
			tos: to,
		}),
		quote = new Note({
			id: new URL('https://1.1.1.1/posts/quiet-quote'),
			attribution: actor.id,
			content: 'Quote',
			tos: to,
		}),
		note = new Note({
			id: new URL('https://1.1.1.1/posts/quiet'),
			attribution: actor.id,
			content: 'Historical reply with a quote',
			tos: to,
			replyTarget: parent.id,
			quote: quote.id,
		})
	for (const object of [parent, quote]) documents.set(object.id!.href, await object.toJsonLd())
	const saved = await persistStatus(ctx, note, remote, 0, {
		quiet: true,
		documentLoader: await ctx.getDocumentLoader({ identifier: 'alice' }),
	})
	expect(saved).toMatchObject({ account_id: remote.id })
	expect(saved!.in_reply_to_id).not.toBeNull()
	expect(saved!.quote_id).not.toBeNull()
	expect(await all(env, 'SELECT id FROM statuses')).toHaveLength(3)
	expect(await all(env, "SELECT id FROM jobs WHERE kind='status.event'")).toHaveLength(0)
	expect(await all(env, 'SELECT id FROM notifications WHERE account_id=?', local.id)).toHaveLength(0)
	expect(requests.every((request) => request.signed && request.owner === env.PUBLIC_ORIGIN + '/users/alice')).toBe(true)
})
