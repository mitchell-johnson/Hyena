import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import type { Message } from '@fedify/fedify'
import type { JobRow } from '../src/types'
import { env, runtime, seed, json } from './support'
import { one, run } from '../src/data'
import { executeJob } from '../src/jobs'
import { seal, unseal } from '../src/federation/keys'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

async function followDelivery() {
	const local = await seed('alice')
	await run(
		env,
		'INSERT INTO accounts(id,username,domain,uri,inbox,created_at) VALUES(?,?,?,?,?,?)',
		'remote-bob',
		'bob',
		'remote.example',
		'https://remote.example/users/bob',
		'https://remote.example/inbox',
		new Date().toISOString()
	)
	await json('/api/v1/accounts/remote-bob/follow', { token: local.token, method: 'POST', body: {} })
	const intent = (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.send'"))!
	await executeJob(env, intent.id)
	return (await one<JobRow>(env, "SELECT * FROM jobs WHERE kind='federation.message'"))!
}

it.each([10, 10000])(
	'retains a retryable delivery with Fedify attempt %s until the D1 budget is exhausted',
	async (attempt) => {
		const delivery = await followDelivery(),
			payload = JSON.parse(delivery.payload),
			message = await unseal<Message>(env, payload.messageCipher)
		payload.messageCipher = await seal(env, { ...message, attempt })
		await run(env, 'UPDATE jobs SET payload=? WHERE id=?', JSON.stringify(payload), delivery.id)
		const send = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('Try later', { status: 429, headers: { 'Retry-After': '120' } }))
		await executeJob(env, delivery.id)
		const deferred = (await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id))!
		expect(deferred).toMatchObject({ state: 'pending', attempt: 1, last_error: 'Remote server deferred delivery' })
		expect(await unseal(env, JSON.parse(deferred.payload).messageCipher)).toMatchObject({ attempt: attempt + 1 })
		expect(Number.isFinite(deferred.available_at)).toBe(true)
		const sent = send.mock.calls.length
		expect(sent).toBeGreaterThan(0)
		await run(env, 'UPDATE jobs SET available_at=? WHERE id=?', Date.now(), delivery.id)
		send.mockResolvedValue(new Response(null, { status: 202 }))
		await executeJob(env, delivery.id)
		expect(send).toHaveBeenCalledTimes(sent + 1)
		expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({
			state: 'done',
			attempt: 2,
			last_error: null,
		})
	}
)

it('expires an excessive Retry-After at the delivery deadline without sending early', async () => {
	const delivery = await followDelivery(),
		send = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response('Try next year', { status: 503, headers: { 'Retry-After': String(365 * 86400) } })
			)
	await executeJob(env, delivery.id)
	const deferred = (await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id))!
	expect(deferred.state).toBe('pending')
	expect(deferred.available_at).toBe(deferred.first_attempt_at! + 7 * 86400000)
	const sent = send.mock.calls.length
	expect(sent).toBeGreaterThan(0)
	const clock = vi.spyOn(Date, 'now').mockReturnValue(deferred.available_at - 1)
	await executeJob(env, delivery.id)
	expect(send).toHaveBeenCalledTimes(sent)
	expect((await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id))?.state).toBe('pending')
	clock.mockReturnValue(deferred.available_at)
	await executeJob(env, delivery.id)
	expect(send).toHaveBeenCalledTimes(sent)
	expect(await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', delivery.id)).toMatchObject({
		state: 'dead',
		lease_token: null,
		last_error: 'Remote delivery retry limit reached',
	})
})
