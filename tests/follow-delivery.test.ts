import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { Accept, Follow, Person } from '@fedify/vocab'
import { createFederation, type InboxContext, type Message } from '@fedify/fedify'
import { getDocumentLoader } from '@fedify/vocab-runtime'
import { Temporal } from '@js-temporal/polyfill'
import type { Env, JobRow } from '../src/types'
import { env, runtime, seed, json } from './support'
import { all, one } from '../src/data'
import { executeJob } from '../src/jobs'
import { receive } from '../src/federation/receive'
import { D1KvStore, D1MessageQueue } from '../src/federation/storage'
import { unseal } from '../src/federation/keys'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

async function pendingFollow() {
	const local = await seed('alice'),
		remote = new Person({
			id: new URL('https://remote.example/users/bob'),
			preferredUsername: 'bob',
			inbox: new URL('https://remote.example/users/bob/inbox'),
		}),
		document = await remote.toJsonLd(),
		f = createFederation<Env>({
			origin: env.PUBLIC_ORIGIN,
			kv: new D1KvStore(env),
			contextLoaderFactory: () => getDocumentLoader(),
			documentLoaderFactory: () => async (url: string) => ({ contextUrl: null, documentUrl: url, document }),
		}),
		ctx = f.createContext(new URL(env.PUBLIC_ORIGIN), env) as InboxContext<Env>
	await env.DB.prepare('INSERT INTO accounts(id,username,domain,uri,inbox,created_at) VALUES(?,?,?,?,?,?)')
		.bind('remote-bob', 'bob', 'remote.example', remote.id!.href, remote.inboxId!.href, new Date().toISOString())
		.run()
	expect(
		await json('/api/v1/accounts/remote-bob/follow', { token: local.token, method: 'POST', body: {} })
	).toMatchObject({ following: false, requested: true })
	const intent = (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.send'"))!
	await executeJob(env, intent.id)
	expect((await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', intent.id))?.state).toBe('done')
	const delivery = (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.message'"))!
	expect(delivery).not.toBeNull()
	return { local, remote, ctx, delivery, activity: JSON.parse(intent.payload).activity }
}

it('delivers a remote Follow and applies the remote inline Accept', async () => {
	const { local, remote, ctx, delivery, activity } = await pendingFollow(),
		sent: Record<string, unknown>[] = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		expect(request.url).toBe(remote.inboxId!.href)
		expect(request.headers.has('signature') || request.headers.has('signature-input')).toBe(true)
		sent.push(await request.json())
		return new Response(null, { status: 202 })
	})
	await executeJob(env, delivery.id)
	expect((await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id))?.state).toBe('done')
	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({
		id: activity.id,
		type: 'Follow',
		actor: env.PUBLIC_ORIGIN + '/users/alice',
		object: remote.id!.href,
	})
	await receive(
		ctx,
		new Accept({
			id: new URL('https://remote.example/activities/accept-1'),
			actor: remote.id,
			object: new Follow({
				id: new URL(activity.id),
				actor: new URL(env.PUBLIC_ORIGIN + '/users/alice'),
				object: remote.id,
			}),
		})
	)
	expect(await json('/api/v1/accounts/relationships?id[]=remote-bob', { token: local.token })).toMatchObject([
		{ following: true, requested: false },
	])
})

it.each([429, 503])('retains an outbound Follow after HTTP %s Retry-After and delivers it later', async (status) => {
	const { remote, delivery } = await pendingFollow()
	const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		expect(request.url).toBe(remote.inboxId!.href)
		return new Response('Try later', { status, headers: { 'Retry-After': '120' } })
	})
	const before = Date.now()
	await executeJob(env, delivery.id)
	const pending = await all<JobRow>(
		env,
		"SELECT * FROM jobs WHERE kind='federation.message' AND state IN ('pending','queued')"
	)
	expect(pending).toHaveLength(1)
	expect(pending[0]).toMatchObject({ id: delivery.id, attempt: 1, lease_token: null, created_at: delivery.created_at })
	expect(pending[0]!.available_at).toBeGreaterThanOrEqual(before + 120000)
	const deferred = await unseal<Message>(env, JSON.parse(pending[0]!.payload).messageCipher)
	expect(deferred).toMatchObject({ attempt: 1 })
	const attempts = send.mock.calls.length
	expect(attempts).toBeGreaterThan(0)
	await executeJob(env, delivery.id)
	expect(send).toHaveBeenCalledTimes(attempts)
	await env.DB.prepare('UPDATE jobs SET available_at=? WHERE id=?').bind(Date.now(), delivery.id).run()
	send.mockResolvedValue(new Response(null, { status: 202 }))
	await executeJob(env, delivery.id)
	expect(send).toHaveBeenCalledTimes(attempts + 1)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({
		state: 'done',
		attempt: 2,
		last_error: null,
	})
})

it('deduplicates producer messages and rejects rescheduling by a stale processing lease', async () => {
	const { delivery } = await pendingFollow(),
		payload = JSON.parse(delivery.payload),
		message = await unseal<Message>(env, payload.messageCipher),
		delay = Temporal.Duration.from({ seconds: 120 }) as unknown as globalThis.Temporal.Duration,
		options = { delay, orderingKey: payload.orderingKey }
	await new D1MessageQueue(env).enqueue(message, options)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toEqual(delivery)
	await env.DB.prepare("UPDATE jobs SET state='processing',lease_token='new-owner',lease_until=? WHERE id=?")
		.bind(Date.now() + 300000, delivery.id)
		.run()
	const claimed = await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)
	await new D1MessageQueue(env, { id: delivery.id, token: 'stale-owner' }).enqueue(message, options)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toEqual(claimed)
	await new D1MessageQueue(env, { id: delivery.id, token: 'new-owner' }).enqueue(message, options)
	const deferred = await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)
	expect(deferred).toMatchObject({ state: 'pending', lease_token: null, created_at: delivery.created_at })
	expect(deferred!.available_at).toBeGreaterThan(delivery.available_at)
	await new D1MessageQueue(env).enqueue(message, options)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toEqual(deferred)
	expect(await all<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.message'")).toHaveLength(1)
})

it.each(['attempts', 'age'])('stops explicit remote deferrals after the delivery %s limit', async (limit) => {
	const { delivery } = await pendingFollow(),
		message = await unseal<Message>(env, JSON.parse(delivery.payload).messageCipher)
	await env.DB.prepare("UPDATE jobs SET state='processing',lease_token='owner',attempt=?,first_attempt_at=? WHERE id=?")
		.bind(limit === 'attempts' ? 100 : 1, Date.now() - (limit === 'age' ? 7 * 86400000 : 0), delivery.id)
		.run()
	await new D1MessageQueue(env, { id: delivery.id, token: 'owner' }).enqueue(message)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({
		state: 'dead',
		last_error: 'Remote delivery retry limit reached',
		lease_token: null,
	})
})

it.each([false, true])('cancels a deferred Follow and orders its Undo before a re-follow (%s)', async (refollow) => {
	const { local, delivery, activity } = await pendingFollow(),
		send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('Try later', {
				status: 429,
				headers: { 'Retry-After': '120' },
			})
		)
	await executeJob(env, delivery.id)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({ state: 'pending' })
	await json('/api/v1/accounts/remote-bob/unfollow', { token: local.token, method: 'POST', body: {} })
	const undo = (await one<JobRow>(
		env,
		"SELECT * FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.type')='Undo'"
	))!
	if (refollow) await json('/api/v1/accounts/remote-bob/follow', { token: local.token, method: 'POST', body: {} })
	await executeJob(env, undo.id)
	if (refollow) {
		const fresh = (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.send' AND state='pending'"))!
		expect(JSON.parse(fresh.payload).orderingKey).toBe(JSON.parse(undo.payload).orderingKey)
		await executeJob(env, fresh.id)
	}
	const deliveries = await all<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.message' ORDER BY rowid"),
		undoDelivery = deliveries[1]!,
		sent: Record<string, unknown>[] = []
	expect(deliveries).toHaveLength(refollow ? 3 : 2)
	expect(JSON.parse(undoDelivery.payload).orderingKey).toBe(JSON.parse(delivery.payload).orderingKey)
	send.mockImplementation(async (input, init) => {
		sent.push(await new Request(input, init).json())
		return new Response(null, { status: 202 })
	})
	await executeJob(env, undoDelivery.id)
	expect(sent).toHaveLength(0)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', undoDelivery.id)).toMatchObject({
		state: 'pending',
		attempt: 0,
	})
	const makeDue = async (id: string) => {
		await env.DB.prepare('UPDATE jobs SET available_at=? WHERE id=?').bind(Date.now(), id).run()
		await executeJob(env, id)
	}
	await makeDue(delivery.id)
	expect(sent).toHaveLength(0)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({ state: 'done' })
	await makeDue(undoDelivery.id)
	expect(sent).toMatchObject([{ type: 'Undo', object: { type: 'Follow', id: activity.id } }])
	if (refollow) {
		await makeDue(deliveries[2]!.id)
		expect(sent).toHaveLength(2)
		expect(sent[1]).toMatchObject({ type: 'Follow', object: activity.object })
		expect(sent[1]!.id).not.toBe(activity.id)
	}
})
