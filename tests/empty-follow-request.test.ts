import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, reset } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import worker from '../src/index'
import { all, one, run } from '../src/data'
import { env, json, runtime, seed } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

async function followTarget() {
	const owner = await seed('alice')
	await run(
		env,
		'INSERT INTO accounts(id,username,domain,uri,inbox,created_at) VALUES(?,?,?,?,?,?)',
		'remote-bob',
		'bob',
		'remote.example',
		'https://remote.example/users/bob',
		'https://remote.example/users/bob/inbox',
		new Date().toISOString()
	)
	const path = '/api/v1/accounts/remote-bob/follow'
	return {
		owner,
		path,
		current: () => one(env, 'SELECT * FROM follows WHERE follower_id=? AND following_id=?', owner.id, 'remote-bob'),
		jobs: () => all(env, "SELECT * FROM jobs WHERE kind='federation.send'"),
		async post(body: BodyInit, headers: Record<string, string> = {}) {
			const request = new Request(env.PUBLIC_ORIGIN + path, {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + owner.token, ...headers },
				body,
			})
			// Native clients can send an empty stream rather than omit the body.
			expect(request.body).not.toBeNull()
			const ctx = createExecutionContext(),
				response = await worker.fetch(request, env, ctx)
			await waitOnExecutionContext(ctx)
			return response
		},
	}
}

interface FollowInput {
	name: string
	body: BodyInit
	headers: Record<string, string>
}

const emptyRequests: FollowInput[] = [
	{ name: 'no Content-Type', body: new Uint8Array(0), headers: {} },
	{ name: 'the default text/plain Content-Type', body: '', headers: {} },
	{ name: 'application/json', body: '', headers: { 'Content-Type': 'application/json' } },
]

it.each(emptyRequests)(
	'accepts an empty follow request with $name and preserves repeated follow preferences',
	async ({ body, headers }) => {
		const { owner, path, post, current, jobs } = await followTarget(),
			response = await post(body, headers)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			id: 'remote-bob',
			following: false,
			requested: true,
			showing_reblogs: true,
			notifying: false,
			languages: [],
		})
		const original = await current(),
			originalJobs = await jobs()
		expect(originalJobs).toHaveLength(1)
		expect(await (await post(body, headers)).json()).toMatchObject({ requested: true, showing_reblogs: true })
		expect(await current()).toEqual(original)

		await json(path, { token: owner.token, method: 'POST', body: { reblogs: false, notify: true, languages: ['en'] } })
		const customized = await current(),
			repeated = await post(body, headers)
		expect(repeated.status).toBe(200)
		expect(await repeated.json()).toMatchObject({
			requested: true,
			showing_reblogs: false,
			notifying: true,
			languages: ['en'],
		})
		expect(await current()).toEqual(customized)
		expect(await jobs()).toEqual(originalJobs)
	}
)

const invalidRequests: (FollowInput & { status: number })[] = [
	{ name: 'nonempty unsupported text', body: 'notify=true', headers: {}, status: 415 },
	{ name: 'malformed JSON', body: '{', headers: { 'Content-Type': 'application/json' }, status: 400 },
	{ name: 'an oversized stream', body: new Uint8Array(65537), headers: {}, status: 413 },
	{
		name: 'an empty stream advertising an oversized length',
		body: new Uint8Array(0),
		headers: { 'Content-Length': '65537' },
		status: 413,
	},
]

it.each(invalidRequests)(
	'rejects $name without creating a follow or delivery job',
	async ({ body, headers, status }) => {
		const { post, current, jobs } = await followTarget()
		expect((await post(body, headers)).status).toBe(status)
		expect(await current()).toBeNull()
		expect(await jobs()).toEqual([])
	}
)
