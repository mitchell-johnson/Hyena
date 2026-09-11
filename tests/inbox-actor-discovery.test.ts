import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { verifyRequest, type InboxContext, type Message } from '@fedify/fedify'
import { Accept, Activity, Create, Note, Person } from '@fedify/vocab'
import { Temporal } from '@js-temporal/polyfill'
import { federation } from '../src/federation'
import { persistActor, receive } from '../src/federation/receive'
import { D1MessageQueue } from '../src/federation/storage'
import { executeJob } from '../src/jobs'
import { all, one, run } from '../src/data'
import type { Env, JobRow } from '../src/types'
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
		requests: { signed: boolean; owner: string | null }[] = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		if (request.url !== actor.id!.href) throw new Error('Unexpected federation request')
		const key = await verifyRequest(request.clone(), {
			documentLoader: async (url) => ({ contextUrl: null, documentUrl: url, document: localDocument }),
		})
		requests.push({ signed: !!key, owner: key?.ownerId?.href ?? null })
		return key
			? Response.json(document, { headers: { 'Content-Type': 'application/activity+json' } })
			: new Response('Signed actor request required', { status: 401 })
	})
	return { local, ctx, actor, remote, requests }
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
