import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { verifyRequest } from '@fedify/fedify'
import { Person } from '@fedify/vocab'
import { federation } from '../src/federation'
import { persistActor } from '../src/federation/receive'
import { followBackfillStatement, processFollowBackfill, queueFollowBackfill } from '../src/federation/backfill'
import { all, one, run } from '../src/data'
import { nextId } from '../src/db'
import { executeJob, sweep } from '../src/jobs'
import type { JobRow, StatusRow } from '../src/types'
import { env, runtime, seed, json } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

const origin = 'https://1.1.1.1',
	actorUri = origin + '/users/bob',
	outboxUri = actorUri + '/outbox',
	pub = 'https://www.w3.org/ns/activitystreams#Public',
	context = 'https://www.w3.org/ns/activitystreams'
function post(i: number, overrides: Record<string, unknown> = {}) {
	return {
		id: origin + '/posts/' + i,
		type: 'Note',
		attributedTo: actorUri,
		to: [pub],
		content: '<p>Historical post ' + i + '</p>',
		published: new Date(Date.UTC(2025, 1, 1) + i * 1000).toISOString(),
		...overrides,
	}
}
function create(i: number, object = post(i)) {
	return { type: 'Create', id: origin + '/activities/' + i, actor: actorUri, object }
}
async function setup(items: unknown[] = [create(1)]) {
	const local = await seed('alice'),
		ctx = (await federation(env)).createContext(new Request(env.PUBLIC_ORIGIN), env),
		localDocument = await (await ctx.getActor('alice'))!.toJsonLd(),
		actor = new Person({
			id: new URL(actorUri),
			preferredUsername: 'bob',
			inbox: new URL(origin + '/inbox'),
			outbox: new URL(outboxUri),
			followers: new URL(actorUri + '/followers'),
		}),
		remote = await persistActor(ctx, actor),
		payload = { followerId: local.id, followingId: remote.id, followUri: env.PUBLIC_ORIGIN + '/activities/follow-1' },
		documents = new Map<string, unknown>([
			[actorUri, await actor.toJsonLd()],
			[outboxUri, { '@context': context, id: outboxUri, type: 'OrderedCollection', orderedItems: items }],
		]),
		requests: string[] = []
	await run(
		env,
		"INSERT INTO follows(id,follower_id,following_id,state,activity_uri,created_at) VALUES(?,?,?,'accepted',?,?)",
		await nextId(env.DB),
		local.id,
		remote.id,
		payload.followUri,
		new Date().toISOString()
	)
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		requests.push(request.url)
		const key = await verifyRequest(request.clone(), {
			documentLoader: async (url) => ({ contextUrl: null, documentUrl: url, document: localDocument }),
		})
		expect(key?.ownerId?.href).toBe(env.PUBLIC_ORIGIN + '/users/alice')
		if (!documents.has(request.url)) throw new Error('Unexpected history fetch: ' + request.url)
		return Response.json(documents.get(request.url), { headers: { 'Content-Type': 'application/activity+json' } })
	})
	return { local, remote, payload, documents, requests }
}

it('fetches recent public originals with the local follower signature, preserves dates, and populates home without notifications', async () => {
	const items = Array.from({ length: 22 }, (_, i) => create(i)),
		{ local, remote, payload, requests } = await setup(items)
	await (await followBackfillStatement(env, payload)).run()
	await processFollowBackfill(env, payload)
	const statuses = await all<StatusRow>(env, 'SELECT * FROM statuses WHERE account_id=? ORDER BY created_at', remote.id)
	expect(statuses).toHaveLength(20)
	expect(statuses.map((status) => status.uri)).toEqual(items.slice(2).map((item) => item.object.id))
	expect(statuses.map((status) => status.created_at)).toEqual(
		items.slice(2).map((item) => item.object.published.replace('.000Z', 'Z'))
	)
	expect(statuses.every((status) => status.visibility === 'public' && status.local === 0)).toBe(true)
	expect(requests).toEqual([actorUri, outboxUri])
	expect(
		await all(env, "SELECT id FROM jobs WHERE kind IN ('status.event','notification.push','federation.send')")
	).toHaveLength(0)
	expect(await all(env, 'SELECT id FROM notifications')).toHaveLength(0)
	const timeline = await json<{ uri: string }[]>('/api/v1/timelines/home', { token: local.token })
	expect(timeline.map((status) => status.uri).sort()).toEqual(statuses.map((status) => status.uri!).sort())
})

it('deduplicates repeated scheduling and retries and never overwrites an existing cached status', async () => {
	const { payload, documents } = await setup()
	await (await followBackfillStatement(env, payload)).run()
	await (await followBackfillStatement(env, payload)).run()
	expect(await all<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.backfill'")).toHaveLength(1)
	await processFollowBackfill(env, payload)
	const original = await all<StatusRow>(env, 'SELECT * FROM statuses')
	documents.set(outboxUri, {
		'@context': context,
		id: outboxUri,
		type: 'OrderedCollection',
		orderedItems: [
			create(1, post(1, { content: '<p>Changed in an old fetch</p>', updated: new Date().toISOString() })),
		],
	})
	await processFollowBackfill(env, payload)
	expect(await all<StatusRow>(env, 'SELECT * FROM statuses')).toEqual(original)
	expect(await queueFollowBackfill(env, payload.followerId)).toBe(0)
})

it.each(['unfollow', 'replacement', 'pending', 'blocked', 'user domain block', 'domain policy', 'disabled'])(
	'cancels %s history before any network fetch',
	async (change) => {
		const { local, remote, payload, requests } = await setup()
		if (change === 'unfollow') await run(env, 'DELETE FROM follows')
		else if (change === 'replacement') await run(env, "UPDATE follows SET activity_uri='https://hyena.example/other'")
		else if (change === 'pending') await run(env, "UPDATE follows SET state='pending'")
		else if (change === 'blocked')
			await run(
				env,
				"INSERT INTO account_actions(id,account_id,target_id,kind,created_at) VALUES(?,?,?,'block',?)",
				await nextId(env.DB),
				local.id,
				remote.id,
				new Date().toISOString()
			)
		else if (change === 'user domain block')
			await run(env, 'INSERT INTO user_domain_blocks(account_id,domain) VALUES(?,?)', local.id, '1.1.1.1')
		else if (change === 'domain policy')
			await run(
				env,
				"INSERT INTO moderation_rules(id,kind,value,data,created_at) VALUES(?,'domain_blocks','1.1.1.1',?,?)",
				await nextId(env.DB),
				JSON.stringify({ severity: 'suspend' }),
				new Date().toISOString()
			)
		else await run(env, 'UPDATE accounts SET disabled=1 WHERE id=?', local.id)
		await processFollowBackfill(env, payload)
		expect(requests).toHaveLength(0)
		expect(await all(env, 'SELECT id FROM statuses')).toHaveLength(0)
	}
)

it('rejects private, unlisted, boosted, foreign-attribution, and cross-origin posts without fetching reply parents', async () => {
	const { local, payload, requests } = await setup([
		create(1, post(1, { to: [actorUri + '/followers'] })),
		create(2, post(2, { to: [actorUri + '/followers'], cc: [pub] })),
		create(3, post(3, { attributedTo: origin + '/users/another' })),
		create(4, post(4, { attributedTo: [actorUri, origin + '/users/another'] })),
		create(5, post(5, { id: 'https://elsewhere.example/spoofed' })),
		{ ...create(6), id: 'https://elsewhere.example/activity' },
		{ type: 'Announce', id: origin + '/activities/7', actor: actorUri, object: post(7) },
		'https://elsewhere.example/foreign-item',
		create(
			9,
			post(9, { inReplyTo: 'https://elsewhere.example/private-parent', cc: [env.PUBLIC_ORIGIN + '/users/alice'] })
		),
	])
	await processFollowBackfill(env, payload)
	expect((await all<StatusRow>(env, 'SELECT * FROM statuses')).map((status) => status.uri)).toEqual([
		origin + '/posts/9',
	])
	expect(requests).toEqual([actorUri, outboxUri])
	expect(await all(env, 'SELECT id FROM notifications WHERE account_id=?', local.id)).toHaveLength(0)
	expect(await all(env, "SELECT id FROM jobs WHERE kind='status.event'")).toHaveLength(0)
})

it('requires the actor document to identify the exact followed account', async () => {
	const { payload, documents, requests } = await setup()
	documents.set(actorUri, {
		'@context': context,
		id: origin + '/users/impostor',
		type: 'Person',
		preferredUsername: 'impostor',
		inbox: origin + '/inbox',
		outbox: outboxUri,
	})
	await processFollowBackfill(env, payload)
	expect(requests).toEqual([actorUri])
	expect(await all(env, 'SELECT id FROM statuses')).toHaveLength(0)
})

it('limits traversal to two data pages and forty scanned entries before selecting the newest twenty', async () => {
	const { payload, documents, requests } = await setup(),
		first = outboxUri + '?page=1',
		second = outboxUri + '?page=2',
		third = outboxUri + '?page=3'
	documents.set(outboxUri, { '@context': context, id: outboxUri, type: 'OrderedCollection', first })
	for (const [page, next, offset] of [
		[first, second, 0],
		[second, third, 25],
	] as const)
		documents.set(page, {
			'@context': context,
			id: page,
			type: 'OrderedCollectionPage',
			partOf: outboxUri,
			next,
			orderedItems: Array.from({ length: 25 }, (_, i) => create(i + offset)),
		})
	await processFollowBackfill(env, payload)
	expect(requests).toEqual([actorUri, outboxUri, first, second])
	expect((await all<StatusRow>(env, 'SELECT * FROM statuses ORDER BY created_at')).map((status) => status.uri)).toEqual(
		Array.from({ length: 20 }, (_, i) => origin + '/posts/' + (i + 20))
	)
})

it.each(['cycle', 'foreign'])('stops %s collection pagination', async (kind) => {
	const { payload, documents, requests } = await setup(),
		first = outboxUri + '?page=1'
	documents.set(outboxUri, { '@context': context, id: outboxUri, type: 'OrderedCollection', first })
	documents.set(first, {
		'@context': context,
		id: first,
		type: 'OrderedCollectionPage',
		partOf: outboxUri,
		next: kind === 'cycle' ? first : 'https://elsewhere.example/outbox',
		orderedItems: [create(1)],
	})
	await processFollowBackfill(env, payload)
	expect(requests).toEqual([actorUri, outboxUri, first])
	expect(await all(env, 'SELECT id FROM statuses')).toHaveLength(1)
})

it('rechecks an unfollow that happens during the outbox fetch before saving any posts', async () => {
	const { payload } = await setup(),
		fetch = globalThis.fetch
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const response = await fetch(input, init)
		if (new Request(input, init).url === outboxUri) await run(env, 'DELETE FROM follows')
		return response
	})
	await processFollowBackfill(env, payload)
	expect(await all(env, 'SELECT id FROM statuses')).toHaveLength(0)
})

it('prepares bounded repair batches without starving follows beyond the first twenty', async () => {
	const { local, remote } = await setup()
	for (let i = 0; i < 24; i++) {
		const id = await nextId(env.DB)
		await run(
			env,
			'INSERT INTO accounts(id,username,domain,uri,created_at) VALUES(?,?,?,?,?)',
			id,
			'remote' + i,
			'1.1.1.1',
			origin + '/users/remote' + i,
			new Date().toISOString()
		)
		await run(
			env,
			"INSERT INTO follows(id,follower_id,following_id,state,activity_uri,created_at) VALUES(?,?,?,'accepted',?,?)",
			await nextId(env.DB),
			local.id,
			id,
			env.PUBLIC_ORIGIN + '/follow/' + i,
			new Date().toISOString()
		)
	}
	expect(await queueFollowBackfill(env, local.id)).toBe(20)
	expect(await queueFollowBackfill(env, local.id)).toBe(5)
	expect(await queueFollowBackfill(env, local.id)).toBe(0)
	expect(await all(env, "SELECT id FROM jobs WHERE kind='federation.backfill'")).toHaveLength(25)
	expect(
		await one(
			env,
			"SELECT id FROM jobs WHERE kind='federation.backfill' AND json_extract(payload,'$.followingId')=?",
			remote.id
		)
	).not.toBeNull()
})

it('keeps old history below newer posts and allocates distinct IDs for an already occupied timestamp', async () => {
	const published = post(1).published,
		{ local, remote, payload } = await setup([create(1), create(2, post(2, { published }))]),
		seedId = BigInt(Date.parse(published)) << 16n,
		occupied = (seedId + 7n).toString()
	await run(
		env,
		`INSERT INTO statuses(id,sequence,account_id,text,content,visibility,created_at,mutation_id,local) VALUES(?,CAST(? AS INTEGER),?,?,?,'public',?,?,0)`,
		occupied,
		occupied,
		remote.id,
		'Already cached',
		'<p>Already cached</p>',
		published,
		crypto.randomUUID()
	)
	const fresh = await json<{ id: string }>('/api/v1/statuses', {
		token: local.token,
		method: 'POST',
		body: { status: 'A new post above the historical imports' },
	})
	await processFollowBackfill(env, payload)
	const rows = await all<StatusRow>(env, 'SELECT * FROM statuses WHERE uri IS NOT NULL ORDER BY sequence')
	expect(rows.map((row) => row.id)).toEqual([(seedId + 8n).toString(), (seedId + 9n).toString()])
	const home = await json<{ id: string }[]>('/api/v1/timelines/home', { token: local.token })
	expect(home.map((status) => status.id)).toEqual([fresh.id, rows[1]!.id, rows[0]!.id, occupied])
	const older = await json<{ id: string }[]>('/api/v1/timelines/home?max_id=' + rows[1]!.id, { token: local.token })
	expect(older.map((status) => status.id)).toEqual([rows[0]!.id, occupied])
})

it('queues missing history on home reads and retains the completed receipt until the follow ends', async () => {
	const { local } = await setup()
	await json('/api/v1/timelines/home', { token: local.token })
	const job = (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.backfill'"))!
	expect(job).not.toBeNull()
	await executeJob(env, job.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', job.id)).toMatchObject({
		state: 'done',
		last_error: null,
	})
	await run(env, 'UPDATE jobs SET completed_at=? WHERE id=?', Date.now() - 9 * 86400000, job.id)
	await sweep(env)
	expect(await one(env, 'SELECT id FROM jobs WHERE id=?', job.id)).not.toBeNull()
	await json('/api/v1/timelines/home', { token: local.token })
	expect(await all(env, "SELECT id FROM jobs WHERE kind='federation.backfill'")).toHaveLength(1)
	await run(env, 'DELETE FROM follows')
	await sweep(env)
	expect(await one(env, 'SELECT id FROM jobs WHERE id=?', job.id)).toBeNull()
})
