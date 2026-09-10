import { env as runtimeEnv } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, reset } from 'cloudflare:test'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import type { D1Migration } from '@cloudflare/vitest-plugin'
import worker from '../src/index'
import type { Env, StatusRow } from '../src/types'
import { digest, randomToken } from '../src/auth/crypto'
import { nextId } from '../src/db'
import { executeJob } from '../src/jobs'
import { encryptPush } from '../src/push'
const runtime = runtimeEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] }
const env: Env = { ...runtime, JOBS: { send: async () => {} } as unknown as Env['JOBS'] }
async function request(path: string, token?: string, method = 'GET', body?: unknown) {
	const ctx = createExecutionContext(),
		res = await worker.fetch(
			new Request(env.PUBLIC_ORIGIN + path, {
				method,
				headers: {
					...(token ? { Authorization: 'Bearer ' + token } : {}),
					...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			env,
			ctx
		)
	await waitOnExecutionContext(ctx)
	return res
}
async function entity<T = Record<string, unknown>>(
	path: string,
	token?: string,
	method = 'GET',
	body?: unknown
): Promise<T> {
	const r = await request(path, token, method, body),
		data = await r.json<T>()
	expect(r.status, JSON.stringify(data)).toBe(200)
	return data
}
async function seed(name: string, locked = false) {
	const id = await nextId(env.DB),
		app = await nextId(env.DB),
		token = randomToken()
	await env.DB.batch([
		env.DB.prepare(
			'INSERT INTO accounts(id,username,password_hash,created_at,locked,indexable) VALUES(?,?,?,?,?,1)'
		).bind(id, name, 'unused', new Date().toISOString(), +locked),
		env.DB.prepare(
			'INSERT INTO oauth_apps(id,name,client_id,secret_hash,redirect_uris,scopes,created_at) VALUES(?,?,?,?,?,?,?)'
		).bind(
			app,
			name,
			app,
			'unused',
			'["https://app.example/callback"]',
			'read write push profile',
			new Date().toISOString()
		),
		env.DB.prepare('INSERT INTO oauth_tokens(token_hash,app_id,account_id,scopes,created_at) VALUES(?,?,?,?,?)').bind(
			await digest(token),
			app,
			id,
			'read write push profile',
			Date.now()
		),
	])
	return { id, app, token }
}
beforeEach(async () => {
	await applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS)
})
afterEach(async () => {
	await reset()
})
describe('social contract across accounts', () => {
	it('honours locked follows, restricted audiences, context and blocking', async () => {
		const alice = await seed('alice', true),
			bob = await seed('bob'),
			eve = await seed('eve')
		expect((await entity('/api/v1/accounts/' + alice.id + '/follow', bob.token, 'POST', {})).requested).toBe(true)
		const post = await entity('/api/v1/statuses', alice.token, 'POST', {
			status: 'followers only',
			visibility: 'private',
		})
		expect((await request('/api/v1/statuses/' + post.id, bob.token)).status).toBe(404)
		await entity('/api/v1/follow_requests/' + bob.id + '/authorize', alice.token, 'POST', {})
		expect((await entity('/api/v1/statuses/' + post.id, bob.token)).content).toBe('<p>followers only</p>')
		const home = await entity<{ id: string }[]>('/api/v1/timelines/home', bob.token)
		expect(home.map((s) => s.id)).toContain(post.id)
		expect((await request('/api/v1/statuses/' + post.id, eve.token)).status).toBe(404)
		const reply = await entity('/api/v1/statuses', bob.token, 'POST', {
			status: '@alice yes',
			visibility: 'private',
			in_reply_to_id: post.id,
		})
		const context = await entity<{ descendants: { id: string }[] }>(
			'/api/v1/statuses/' + post.id + '/context',
			alice.token
		)
		expect(context.descendants.map((s) => s.id)).toContain(reply.id)
		await entity('/api/v1/accounts/' + bob.id + '/block', alice.token, 'POST', {})
		expect((await request('/api/v1/statuses/' + post.id, bob.token)).status).toBe(404)
		expect(
			(await entity<{ following: boolean }[]>('/api/v1/accounts/relationships?id[]=' + alice.id, bob.token))[0]
				?.following
		).toBe(false)
	})
	it('creates mentions, tags, notifications and private conversations through durable jobs', async () => {
		const a = await seed('alice'),
			b = await seed('bob'),
			e = await seed('eve')
		const s = await entity('/api/v1/statuses', a.token, 'POST', {
			status: '@bob a private #hello',
			visibility: 'direct',
		})
		expect((s.mentions as { id: string }[])[0]?.id).toBe(b.id)
		expect((await request('/api/v1/statuses/' + s.id, e.token)).status).toBe(404)
		await executeJob(env, 'status:' + s.id + ':1')
		const jobs = await env.DB.prepare('SELECT state,last_error FROM jobs WHERE id=?')
			.bind('status:' + s.id + ':1')
			.first()
		expect(jobs).toMatchObject({ state: 'done' })
		const notifications = await entity<{ type: string; status: { id: string } }[]>('/api/v1/notifications', b.token)
		expect(notifications).toHaveLength(1)
		expect(notifications[0]).toMatchObject({ type: 'mention', status: { id: s.id } })
		expect(await entity('/api/v1/notifications', e.token)).toEqual([])
		const conversations = await entity<{ id: string; unread: boolean }[]>('/api/v1/conversations', b.token)
		expect(conversations[0]?.unread).toBe(true)
		expect((await entity('/api/v1/conversations/' + conversations[0]!.id + '/read', b.token, 'POST', {})).unread).toBe(
			false
		)
		await entity('/api/v1/markers', b.token, 'POST', { notifications: { last_read_id: notifications[0]!.status.id } })
		expect(
			(await request('/api/v1/markers', b.token, 'POST', { notifications: { last_read_id: String(s.id), version: 0 } }))
				.status
		).toBe(409)
	})
	it('enforces poll ballot uniqueness and publishes a scheduled status once', async () => {
		const a = await seed('alice'),
			b = await seed('bob'),
			post = await entity<{ id: string; poll: { id: string } }>('/api/v1/statuses', a.token, 'POST', {
				status: 'Choose',
				poll: { options: ['One', 'Two'], expires_in: 3600 },
			})
		const responses = await Promise.all([
			request('/api/v1/polls/' + post.poll.id + '/votes', b.token, 'POST', { choices: [0] }),
			request('/api/v1/polls/' + post.poll.id + '/votes', b.token, 'POST', { choices: [1] }),
		])
		expect(responses.map((r) => r.status).sort()).toEqual([200, 422])
		await Promise.all(responses.map((r) => r.text()))
		const poll = await entity('/api/v1/polls/' + post.poll.id, b.token)
		expect(poll.votes_count).toBe(1)
		const scheduled = await entity<{ id: string }>('/api/v1/statuses', a.token, 'POST', {
			status: 'later today',
			scheduled_at: new Date(Date.now() + 600000).toISOString(),
		})
		expect((await request('/api/v1/statuses/' + scheduled.id, a.token)).status).toBe(404)
		await env.DB.batch([
			env.DB.prepare('UPDATE scheduled_statuses SET scheduled_at=? WHERE id=?').bind(
				new Date(Date.now() - 1000).toISOString(),
				scheduled.id
			),
			env.DB.prepare('UPDATE jobs SET available_at=? WHERE id=?').bind(Date.now() - 1000, 'schedule:' + scheduled.id),
		])
		await executeJob(env, 'schedule:' + scheduled.id)
		await executeJob(env, 'schedule:' + scheduled.id)
		expect(
			(await env.DB.prepare("SELECT COUNT(*) n FROM statuses WHERE text='later today'").first<{ n: number }>())?.n
		).toBe(1)
		expect((await request('/api/v1/scheduled_statuses/' + scheduled.id, a.token)).status).toBe(404)
	})
	it('keeps list ownership, favourites, filters, hashtags and search consistent', async () => {
		const a = await seed('alice'),
			b = await seed('bob')
		await entity('/api/v1/accounts/' + a.id + '/follow', b.token, 'POST', {})
		const l = await entity<{ id: string }>('/api/v1/lists', b.token, 'POST', { title: 'Friends', exclusive: true })
		await entity('/api/v1/lists/' + l.id + '/accounts', b.token, 'POST', { account_ids: [a.id] })
		const s = await entity<{ id: string }>('/api/v1/statuses', a.token, 'POST', { status: 'A #garden tomato' })
		expect((await entity<{ id: string }[]>('/api/v1/timelines/list/' + l.id, b.token)).map((s) => s.id)).toEqual([s.id])
		expect(await entity('/api/v1/timelines/home', b.token)).toEqual([])
		expect((await request('/api/v1/lists/' + l.id, a.token)).status).toBe(404)
		await entity('/api/v1/statuses/' + s.id + '/favourite', b.token, 'POST', {})
		await entity('/api/v1/statuses/' + s.id + '/favourite', b.token, 'POST', {})
		expect((await entity('/api/v1/statuses/' + s.id, b.token)).favourites_count).toBe(1)
		expect((await entity<{ id: string }[]>('/api/v1/favourites', b.token))[0]?.id).toBe(s.id)
		await entity('/api/v2/filters', b.token, 'POST', {
			title: 'Garden',
			context: ['public'],
			filter_action: 'warn',
			keywords_attributes: [{ keyword: 'tomato', whole_word: true }],
		})
		const timeline = await entity<{ filtered: unknown[] }[]>('/api/v1/timelines/tag/garden', b.token)
		expect(timeline[0]?.filtered).toHaveLength(1)
		const results = await entity<{ statuses: { id: string }[] }>('/api/v2/search?q=tomato', b.token)
		expect(results.statuses.map((s) => s.id)).toContain(s.id)
		await entity('/api/v1/tags/garden/follow', b.token, 'POST', {})
		expect((await entity('/api/v1/tags/garden', b.token)).following).toBe(true)
	})
	it('exposes canonical WebFinger and a signed actor without exposing private keys', async () => {
		await seed('alice')
		const finger = await entity<{ subject: string; links: { href: string; rel: string }[] }>(
			'/.well-known/webfinger?resource=acct:alice@hyena.test'
		)
		expect(finger.subject).toBe('acct:alice@hyena.test')
		expect(finger.links.some((l) => l.rel === 'self' && l.href === 'https://hyena.test/users/alice')).toBe(true)
		const ctx = createExecutionContext(),
			response = await worker.fetch(
				new Request('https://hyena.test/users/alice', { headers: { Accept: 'application/activity+json' } }),
				env,
				ctx
			)
		await waitOnExecutionContext(ctx)
		const actor = await response.json<Record<string, unknown>>()
		expect(response.status, JSON.stringify(actor)).toBe(200)
		expect(actor.publicKey).toBeTruthy()
		expect(JSON.stringify(actor)).not.toContain('privateKey')
		const encrypted = await env.DB.prepare("SELECT private_keys FROM accounts WHERE username='alice'").first<{
			private_keys: string
		}>()
		expect(encrypted?.private_keys).toContain('"iv"')
		expect(encrypted?.private_keys).not.toContain('"d"')
	})
})
