import { applyD1Migrations, reset } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Note, Person, Question } from '@fedify/vocab'
import { Temporal } from '@js-temporal/polyfill'
import { federation } from '../src/federation'
import { persistActor, persistStatus } from '../src/federation/receive'
import { all, one, run } from '../src/data'
import { executeJob, sweep } from '../src/jobs'
import { expirePoll } from '../src/poll-expiry'
import type { JobRow } from '../src/types'
import { env, json, runtime, seed } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

const instant = (time: number) => Temporal.Instant.fromEpochMilliseconds(time) as unknown as globalThis.Temporal.Instant

async function setup(expiresAt: number) {
	const local = await seed('alice'),
		ctx = (await federation(env)).createContext(new URL(env.PUBLIC_ORIGIN), env),
		actor = new Person({
			id: new URL('https://remote.example/users/bob'),
			preferredUsername: 'bob',
			inbox: new URL('https://remote.example/inbox'),
		}),
		remote = await persistActor(ctx, actor),
		question = new Question({
			id: new URL('https://remote.example/posts/poll'),
			attribution: actor.id,
			content: '<p>An earlier poll mentioning Alice</p>',
			published: instant(Date.now() - 86400000),
			endTime: instant(expiresAt),
			tos: [new URL('https://www.w3.org/ns/activitystreams#Public'), new URL(env.PUBLIC_ORIGIN + '/users/alice')],
			exclusiveOptions: [new Note({ name: 'Yes' }), new Note({ name: 'No' })],
		}),
		status = (await persistStatus(ctx, question, remote, 0, { quiet: true }))!
	return { local, ctx, remote, question, status }
}

it('keeps already-expired imported polls silent when the expiry sweep runs', async () => {
	const { local, status } = await setup(Date.now() - 10000)
	expect(await one(env, 'SELECT notified_at FROM polls WHERE id=?', status.id)).toEqual({
		notified_at: expect.any(String),
	})
	await sweep(env)
	await expirePoll(env, status.id)
	const events = await all<JobRow>(env, "SELECT * FROM jobs WHERE kind='status.event'")
	for (const event of events) await executeJob(env, event.id)
	expect(events).toHaveLength(0)
	expect(await all(env, 'SELECT id FROM notifications WHERE account_id=?', local.id)).toHaveLength(0)
	expect(await one(env, 'SELECT revision FROM statuses WHERE id=?', status.id)).toEqual({ revision: 1 })
})

it('lets a user vote on an open imported poll and receive its eventual closing notification once', async () => {
	const { local, status } = await setup(Date.now() + 300000)
	expect(await one(env, 'SELECT notified_at FROM polls WHERE id=?', status.id)).toEqual({ notified_at: null })
	await sweep(env)
	expect(await all(env, "SELECT id FROM jobs WHERE kind='status.event'")).toHaveLength(0)
	const vote = await json<{ voted: boolean; own_votes: number[] }>(`/api/v1/polls/${status.id}/votes`, {
		token: local.token,
		method: 'POST',
		body: { choices: [0] },
	})
	expect(vote).toMatchObject({ voted: true, own_votes: [0] })
	expect(
		await all(
			env,
			"SELECT id FROM jobs WHERE kind='federation.send' AND json_extract(payload,'$.activity.object.inReplyTo')=?",
			status.uri!
		)
	).toHaveLength(1)
	expect(await one(env, 'SELECT notified_at FROM polls WHERE id=?', status.id)).toEqual({ notified_at: null })
	await run(env, 'UPDATE polls SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), status.id)
	await sweep(env)
	await sweep(env)
	expect(await all(env, "SELECT id FROM notifications WHERE account_id=? AND type='poll'", local.id)).toHaveLength(1)
	expect(await all(env, "SELECT id FROM jobs WHERE kind='status.event' AND id LIKE 'poll-closed:%'")).toHaveLength(1)
})

it.each([null, '2020-01-01T00:00:00.000Z'])(
	'preserves an existing poll notification marker (%s) during a quiet update',
	async (marker) => {
		const { ctx, remote, question, status } = await setup(Date.now() + 300000)
		await run(env, 'UPDATE polls SET notified_at=? WHERE id=?', marker, status.id)
		await persistStatus(
			ctx,
			question.clone({ endTime: instant(Date.now() - 1000), updated: instant(Date.now()) }),
			remote,
			0,
			{ quiet: true }
		)
		expect(await one(env, 'SELECT notified_at FROM polls WHERE id=?', status.id)).toEqual({ notified_at: marker })
	}
)
