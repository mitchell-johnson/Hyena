import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { Follow, Person } from '@fedify/vocab'
import { createFederation, type InboxContext } from '@fedify/fedify'
import { getDocumentLoader } from '@fedify/vocab-runtime'
import type { Env, JobRow, StatusRow } from '../src/types'
import { env, runtime, seed, json } from './support'
import { all, one, run } from '../src/data'
import { nextId } from '../src/db'
import { executeJob } from '../src/jobs'
import { receive, persistActor } from '../src/federation/receive'
import { D1KvStore } from '../src/federation/storage'
import { processFollowHistory } from '../src/federation/history'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

async function setup(locked = false) {
	const owner = await seed('alice')
	await run(env, 'UPDATE accounts SET locked=? WHERE id=?', +locked, owner.id)
	const actor = new Person({
			id: new URL('https://remote.example/users/bob'),
			preferredUsername: 'bob',
			inbox: new URL('https://remote.example/inbox'),
		}),
		document = await actor.toJsonLd(),
		federation = createFederation<Env>({
			origin: env.PUBLIC_ORIGIN,
			kv: new D1KvStore(env),
			contextLoaderFactory: () => getDocumentLoader(),
			documentLoaderFactory: () => async (url: string) => ({ contextUrl: null, documentUrl: url, document }),
		}),
		ctx = federation.createContext(new URL(env.PUBLIC_ORIGIN), env) as InboxContext<Env>,
		remote = await persistActor(ctx, actor),
		follow = new Follow({
			id: new URL('https://remote.example/activities/follow-1'),
			actor: actor.id,
			object: new URL(env.PUBLIC_ORIGIN + '/users/alice'),
		})
	return { owner, remote, ctx, follow }
}

async function historicalStatus(
	accountId: string,
	options: {
		visibility?: StatusRow['visibility']
		createdAt?: string
		deleted?: boolean
		boostOf?: string
		local?: boolean
	} = {}
) {
	const id = await nextId(env.DB)
	await run(
		env,
		`INSERT INTO statuses(id,sequence,account_id,text,content,visibility,created_at,deleted_at,mutation_id,reblog_of_id,local) VALUES(?,CAST(? AS INTEGER),?,?,?,?,?,?,?,?,?)`,
		id,
		id,
		accountId,
		'An existing post ' + id,
		'<p>An existing post ' + id + '</p>',
		options.visibility ?? 'public',
		options.createdAt ?? new Date(Date.now() - 86400000).toISOString(),
		options.deleted ? new Date().toISOString() : null,
		crypto.randomUUID(),
		options.boostOf ?? null,
		options.local === false ? 0 : 1
	)
	return (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', id))!
}

const histories = () => all<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.history' ORDER BY rowid")
async function executeHistory(job: JobRow) {
	// Deliver approval first, as the remote server must know it follows us
	// before it receives the saved public posts.
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
	for (const approval of await all<JobRow>(
		env,
		"SELECT * FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Accept' AND state IN ('pending','queued') ORDER BY rowid"
	))
		await executeJob(env, approval.id)
	for (const message of await all<JobRow>(
		env,
		"SELECT * FROM jobs WHERE kind='federation.message' AND state IN ('pending','queued') ORDER BY rowid"
	))
		await executeJob(env, message.id)
	await executeJob(env, job.id)
}
async function historyCreates() {
	return (
		await all<{ payload: string }>(
			env,
			"SELECT payload FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Create' ORDER BY rowid"
		)
	).map(
		({ payload }) =>
			JSON.parse(payload) as {
				actorId: string
				recipients: string[]
				activity: { id: string; type: string; object: { id: string; published: string; content: string; to: string[] } }
			}
	)
}

it('automatically sends only the newest twenty existing public original posts to the new remote follower', async () => {
	const { owner, remote, ctx, follow } = await setup(),
		posts: StatusRow[] = []
	for (let i = 0; i < 22; i++)
		posts.push(
			await historicalStatus(owner.id, { createdAt: new Date(Date.now() - 86400000 + i * 1000).toISOString() })
		)
	await historicalStatus(owner.id, { visibility: 'unlisted' })
	await historicalStatus(owner.id, { visibility: 'private' })
	await historicalStatus(owner.id, { visibility: 'direct' })
	await historicalStatus(owner.id, { deleted: true })
	await historicalStatus(owner.id, { boostOf: posts[0]!.id })
	await historicalStatus(owner.id, { local: false })
	const other = await seed('carol')
	await historicalStatus(other.id)
	const priorFollower = await persistActor(
		ctx,
		new Person({
			id: new URL('https://prior.example/users/prior'),
			preferredUsername: 'prior',
			inbox: new URL('https://prior.example/inbox'),
		})
	)
	await run(
		env,
		"INSERT INTO follows(id,follower_id,following_id,state,activity_uri,created_at) VALUES(?,?,?,'accepted',?,?)",
		await nextId(env.DB),
		priorFollower.id,
		owner.id,
		'https://prior.example/follow',
		new Date().toISOString()
	)
	await receive(ctx, follow)
	await historicalStatus(owner.id, { createdAt: new Date(Date.now() + 60000).toISOString() })
	await historicalStatus(owner.id)
	const jobs = await histories()
	expect(jobs).toHaveLength(1)
	await executeHistory(jobs[0]!)
	expect((await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', jobs[0]!.id))?.state).toBe('done')
	const created = await historyCreates(),
		latest = posts.slice(-20)
	expect(created).toHaveLength(20)
	expect(created.map((p) => p.activity.object.id).sort()).toEqual(
		latest.map((p) => `${env.PUBLIC_ORIGIN}/users/alice/statuses/${p.id}`).sort()
	)
	for (const row of created) {
		const post = latest.find((p) => row.activity.object.id.endsWith('/' + p.id))!
		expect(row.actorId).toBe(owner.id)
		expect(row.recipients).toEqual([remote.id])
		expect(row.activity.id).toBe(row.activity.object.id + '#create')
		expect(Date.parse(row.activity.object.published)).toBe(Date.parse(post.created_at))
		expect(row.activity.object.to).toContain('https://www.w3.org/ns/activitystreams#Public')
	}
})

it('waits for manual approval before preparing public history for a locked account', async () => {
	const { owner, remote, ctx, follow } = await setup(true)
	await historicalStatus(owner.id)
	await receive(ctx, follow)
	expect(await histories()).toHaveLength(0)
	await historicalStatus(owner.id, { createdAt: new Date().toISOString() })
	await json(`/api/v1/follow_requests/${remote.id}/authorize`, { token: owner.token, method: 'POST', body: {} })
	const jobs = await histories()
	expect(jobs).toHaveLength(1)
	await executeHistory(jobs[0]!)
	expect((await historyCreates()).map((p) => p.recipients)).toEqual([[remote.id], [remote.id]])
})

it('does not enqueue history for rejected remote requests or local followers', async () => {
	const { owner, remote, ctx, follow } = await setup(true)
	await historicalStatus(owner.id)
	await receive(ctx, follow)
	await json(`/api/v1/follow_requests/${remote.id}/reject`, { token: owner.token, method: 'POST', body: {} })
	expect(await histories()).toHaveLength(0)
	const localFollower = await seed('carol')
	await json(`/api/v1/accounts/${owner.id}/follow`, { token: localFollower.token, method: 'POST', body: {} })
	await json(`/api/v1/follow_requests/${localFollower.id}/authorize`, { token: owner.token, method: 'POST', body: {} })
	expect(await histories()).toHaveLength(0)
	expect(await historyCreates()).toHaveLength(0)
})

it('deduplicates repeated Follow delivery and retries of its history job', async () => {
	const { owner, ctx, follow } = await setup()
	await historicalStatus(owner.id)
	await receive(ctx, follow)
	await receive(ctx, follow)
	const jobs = await histories()
	expect(jobs).toHaveLength(1)
	const payload = JSON.parse(jobs[0]!.payload) as Parameters<typeof processFollowHistory>[1]
	await processFollowHistory(env, payload)
	const created = await historyCreates()
	expect(created).toHaveLength(1)
	await processFollowHistory(env, payload)
	expect(await historyCreates()).toEqual(created)
	await receive(ctx, follow)
	expect(await histories()).toHaveLength(1)
})

it('waits for a deferred Accept to be delivered without counting history waits as processing failures', async () => {
	const { owner, ctx, follow } = await setup()
	await historicalStatus(owner.id)
	await receive(ctx, follow)
	const history = (await histories())[0]!,
		approval = (await one<JobRow>(
			env,
			"SELECT * FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Accept'"
		))!
	await executeJob(env, approval.id)
	const delivery = (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.message'"))!,
		send = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('Later', { status: 429, headers: { 'Retry-After': '120' } }))
	await executeJob(env, delivery.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({
		state: 'pending',
		attempt: 1,
	})
	await executeJob(env, history.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', history.id)).toMatchObject({
		state: 'pending',
		attempt: 0,
		last_error: null,
	})
	expect(await historyCreates()).toHaveLength(0)
	send.mockResolvedValue(new Response(null, { status: 202 }))
	await run(env, 'UPDATE jobs SET available_at=? WHERE id IN (?,?)', Date.now(), delivery.id, history.id)
	await executeJob(env, delivery.id)
	await executeJob(env, history.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', history.id)).toMatchObject({
		state: 'done',
		attempt: 1,
		last_error: null,
	})
	expect(await historyCreates()).toHaveLength(1)
})

it('cancels history when the remote server permanently rejects its Accept', async () => {
	const { owner, ctx, follow } = await setup()
	await historicalStatus(owner.id)
	await receive(ctx, follow)
	const history = (await histories())[0]!,
		approval = (await one<JobRow>(
			env,
			"SELECT * FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Accept'"
		))!
	await executeJob(env, approval.id)
	const delivery = (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.message'"))!
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Gone', { status: 410 }))
	await executeJob(env, delivery.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({
		state: 'dead',
		lease_token: null,
	})
	await executeJob(env, history.id)
	expect((await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', history.id))?.state).toBe('done')
	expect(await historyCreates()).toHaveLength(0)
})

it.each(['pending', 'already skipped'])(
	'delivers history for a new Follow when the old encrypted message is %s',
	async (oldState) => {
		const { owner, remote, ctx, follow } = await setup(),
			post = await historicalStatus(owner.id),
			postUri = `${env.PUBLIC_ORIGIN}/users/alice/statuses/${post.id}`
		await receive(ctx, follow)
		await executeHistory((await histories())[0]!)
		const oldIntent = (await one<JobRow>(
			env,
			"SELECT * FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Create'"
		))!
		await executeJob(env, oldIntent.id)
		const oldMessage = (await one<JobRow>(
			env,
			"SELECT * FROM jobs WHERE kind='federation.message' AND json_extract(payload,'$.activityId')=?",
			postUri + '#create'
		))!
		await run(env, 'DELETE FROM follows WHERE follower_id=? AND following_id=?', remote.id, owner.id)
		if (oldState === 'already skipped') {
			await executeJob(env, oldMessage.id)
			expect((await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', oldMessage.id))?.state).toBe('done')
		}
		const replacement = new Follow({
			id: new URL('https://remote.example/activities/follow-2'),
			actor: new URL(remote.uri!),
			object: new URL(env.PUBLIC_ORIGIN + '/users/alice'),
		})
		await receive(ctx, replacement)
		const history = (await histories()).find((job) => JSON.parse(job.payload).followUri === replacement.id!.href)!
		await executeHistory(history)
		const intent = (await one<JobRow>(
				env,
				"SELECT * FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Create' AND id<>?",
				oldIntent.id
			))!,
			delivered: { id: string; type: string; object: { id: string; published: string } }[] = []
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const request = new Request(input, init)
			expect(request.url).toBe(remote.inbox)
			delivered.push(await request.json())
			return new Response(null, { status: 202 })
		})
		await executeJob(env, intent.id)
		const messages = await all<JobRow>(
			env,
			"SELECT * FROM jobs WHERE kind='federation.message' AND json_extract(payload,'$.activityId')=? ORDER BY rowid",
			postUri + '#create'
		)
		expect(messages).toHaveLength(2)
		for (const message of messages) await executeJob(env, message.id)
		expect(delivered).toHaveLength(1)
		expect(delivered[0]).toMatchObject({
			id: postUri + '#create',
			type: 'Create',
			object: { id: postUri },
		})
		expect(Date.parse(delivered[0]!.object.published)).toBe(Date.parse(post.created_at))
		await processFollowHistory(env, JSON.parse(history.payload) as Parameters<typeof processFollowHistory>[1])
		await executeJob(env, intent.id)
		for (const message of messages) await executeJob(env, message.id)
		expect(delivered).toHaveLength(1)
	}
)

it.each(['cancel', 'replace', 'block', 'domain block', 'delete', 'private', 'suspend'])(
	'rechecks %s before preparing follower history',
	async (change) => {
		const { owner, remote, ctx, follow } = await setup(),
			post = await historicalStatus(owner.id)
		await receive(ctx, follow)
		const job = (await histories())[0]!
		if (change === 'cancel')
			await run(env, 'DELETE FROM follows WHERE follower_id=? AND following_id=?', remote.id, owner.id)
		else if (change === 'replace')
			await run(
				env,
				'UPDATE follows SET activity_uri=? WHERE follower_id=? AND following_id=?',
				'https://remote.example/activities/follow-2',
				remote.id,
				owner.id
			)
		else if (change === 'block')
			await run(
				env,
				"INSERT INTO account_actions(id,account_id,target_id,kind,created_at) VALUES(?,?,?,'block',?)",
				await nextId(env.DB),
				owner.id,
				remote.id,
				new Date().toISOString()
			)
		else if (change === 'domain block')
			await run(
				env,
				"INSERT INTO moderation_rules(id,kind,value,data,created_at) VALUES(?,'domain_blocks','remote.example',?,?)",
				await nextId(env.DB),
				JSON.stringify({ severity: 'suspend' }),
				new Date().toISOString()
			)
		else if (change === 'delete')
			await run(env, 'UPDATE statuses SET deleted_at=? WHERE id=?', new Date().toISOString(), post.id)
		else if (change === 'private') await run(env, "UPDATE statuses SET visibility='private' WHERE id=?", post.id)
		else await run(env, 'UPDATE accounts SET suspended=1 WHERE id=?', remote.id)
		await executeHistory(job)
		expect(await historyCreates()).toHaveLength(0)
	}
)

it.each([
	['intent', 'cancel'],
	['intent', 'private'],
	['intent', 'delete'],
	['encrypted message', 'cancel'],
	['encrypted message', 'private'],
	['encrypted message', 'delete'],
])('rechecks a saved %s after %s before sending history over the network', async (stage, change) => {
	const { owner, remote, ctx, follow } = await setup(),
		post = await historicalStatus(owner.id)
	await receive(ctx, follow)
	await executeHistory((await histories())[0]!)
	const intent = (await one<JobRow>(
		env,
		"SELECT * FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Create'"
	))!
	if (stage === 'encrypted message') await executeJob(env, intent.id)
	if (change === 'cancel')
		await run(env, 'DELETE FROM follows WHERE follower_id=? AND following_id=?', remote.id, owner.id)
	else if (change === 'private') await run(env, "UPDATE statuses SET visibility='private' WHERE id=?", post.id)
	else await run(env, 'UPDATE statuses SET deleted_at=? WHERE id=?', new Date().toISOString(), post.id)
	const send = vi
		.spyOn(globalThis, 'fetch')
		.mockClear()
		.mockResolvedValue(new Response(null, { status: 202 }))
	if (stage === 'intent') await executeJob(env, intent.id)
	for (const message of await all<JobRow>(
		env,
		"SELECT * FROM jobs WHERE kind='federation.message' AND state IN ('pending','queued') ORDER BY rowid"
	))
		await executeJob(env, message.id)
	expect(send).not.toHaveBeenCalled()
})

it('preserves normal federation when a historical post is edited after being sent to a new follower', async () => {
	const { owner, remote, ctx, follow } = await setup(),
		post = await historicalStatus(owner.id)
	await receive(ctx, follow)
	await executeHistory((await histories())[0]!)
	expect(await historyCreates()).toHaveLength(1)
	const delivered: { type: string; object?: { id?: string; content?: string; published?: string } }[] = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		expect(request.url).toBe(remote.inbox)
		delivered.push(await request.json())
		return new Response(null, { status: 202 })
	})
	const deliverPending = async () => {
		for (const kind of ['federation.send', 'federation.message'])
			for (const job of await all<JobRow>(
				env,
				"SELECT * FROM jobs WHERE kind=? AND state IN ('pending','queued') ORDER BY rowid",
				kind
			))
				await executeJob(env, job.id)
	}
	await deliverPending()
	expect(delivered.filter((activity) => activity.type === 'Create')).toHaveLength(1)
	await json(`/api/v1/statuses/${post.id}`, {
		token: owner.token,
		method: 'PUT',
		body: { status: 'Edited after following' },
	})
	const event = (await one<JobRow>(
		env,
		"SELECT * FROM jobs WHERE kind='status.event' AND json_extract(payload,'$.statusId')=?",
		post.id
	))!
	await executeJob(env, event.id)
	const edits = await all<{ payload: string }>(
		env,
		"SELECT payload FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.object.content') LIKE '%Edited after following%'"
	)
	expect(edits).toHaveLength(1)
	expect(JSON.parse(edits[0]!.payload)).toMatchObject({
		actorId: owner.id,
		recipients: [remote.id],
		activity: { object: { id: `${env.PUBLIC_ORIGIN}/users/alice/statuses/${post.id}` } },
	})
	expect(Date.parse(JSON.parse(edits[0]!.payload).activity.object.published)).toBe(Date.parse(post.created_at))
	expect((await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', post.id))?.revision).toBe(2)
	await deliverPending()
	const deliveredEdits = delivered.filter((activity) => activity.object?.content?.includes('Edited after following'))
	expect(deliveredEdits).toHaveLength(1)
	expect(deliveredEdits[0]).toMatchObject({
		type: 'Update',
		object: { id: `${env.PUBLIC_ORIGIN}/users/alice/statuses/${post.id}` },
	})
	expect(Date.parse(deliveredEdits[0]!.object!.published!)).toBe(Date.parse(post.created_at))
})
