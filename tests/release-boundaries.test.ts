import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { env, runtime, seed, json, request } from './support'
import { one, all } from '../src/data'
import { executeJob } from '../src/jobs'
import { federateStatus } from '../src/federation'
import { notificationStatements } from '../src/notifications'
import type { StatusRow } from '../src/types'
beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())
it('applies new domain rules to cached posts and notifications, and restores reads on removal', async () => {
	const owner = await seed('owner', 'admin'),
		remote = await seed('remote')
	const s = await json<{ id: string }>('/api/v1/statuses', {
		token: remote.token,
		method: 'POST',
		body: { status: 'Existing remote post' },
	})
	await env.DB.prepare(
		"UPDATE accounts SET domain='sub.example.net',uri='https://sub.example.net/users/remote' WHERE id=?"
	)
		.bind(remote.id)
		.run()
	await env.DB.batch(await notificationStatements(env, owner.id, remote.id, 'mention', s.id, 'remote-mention'))
	expect((await json<unknown[]>('/api/v1/notifications', { token: owner.token })).length).toBe(1)
	const rule = await json<{ id: string }>('/api/v1/admin/domain_blocks', {
		token: owner.token,
		method: 'POST',
		body: { domain: 'example.net', severity: 'silence' },
	})
	expect(await json('/api/v1/timelines/public')).toEqual([])
	expect((await request('/api/v1/statuses/' + s.id, { token: owner.token })).status).toBe(200)
	await json('/api/v1/admin/domain_blocks/' + rule.id, {
		token: owner.token,
		method: 'PUT',
		body: { severity: 'suspend' },
	})
	expect((await request('/api/v1/statuses/' + s.id, { token: owner.token })).status).toBe(404)
	expect(await json('/api/v1/notifications', { token: owner.token })).toEqual([])
	await json('/api/v1/admin/domain_blocks/' + rule.id, { token: owner.token, method: 'DELETE' })
	expect((await request('/api/v1/statuses/' + s.id, { token: owner.token })).status).toBe(200)
})
it('queues Create before Update when a post is edited before its first delivery', async () => {
	const a = await seed('alice'),
		b = await seed('bob')
	await json('/api/v1/accounts/' + a.id + '/follow', { token: b.token, method: 'POST', body: {} })
	await env.DB.prepare(
		"UPDATE accounts SET domain='remote.example',uri='https://remote.example/users/bob',inbox='https://remote.example/inbox' WHERE id=?"
	)
		.bind(b.id)
		.run()
	const s = await json<{ id: string }>('/api/v1/statuses', {
		token: a.token,
		method: 'POST',
		body: { status: 'first' },
	})
	await json('/api/v1/statuses/' + s.id, { token: a.token, method: 'PUT', body: { status: 'second' } })
	await federateStatus(env, (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', s.id))!)
	await json('/api/v1/statuses/' + s.id, { token: a.token, method: 'PUT', body: { status: 'third' } })
	await federateStatus(env, (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', s.id))!)
	const messages = await all<{ payload: string }>(
		env,
		"SELECT payload FROM jobs WHERE kind='federation.send' AND id LIKE ? ORDER BY rowid",
		'outbound:status-' + s.id + '-%'
	)
	expect(messages.map((x) => JSON.parse(x.payload).activity.type)).toEqual(['Create', 'Update'])
	expect(new Set(messages.map((x) => JSON.parse(x.payload).orderingKey)).size).toBe(1)
})
it('gives a far-future job a retry window from its first attempt', async () => {
	const old = Date.now() - 60 * 86400000
	await env.DB.prepare(
		"INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES('old-scheduled','email.send',?,?,?)"
	)
		.bind(JSON.stringify({ to: 'test@example.net', subject: 'hello', text: 'hello' }), Date.now(), old)
		.run()
	await executeJob(
		{
			...env,
			CONTACT_EMAIL: 'sender@example.net',
			EMAIL: {
				send: async () => {
					throw Error('temporary provider error')
				},
			} as never,
		},
		'old-scheduled'
	)
	expect(await one(env, "SELECT state,attempt FROM jobs WHERE id='old-scheduled'")).toEqual({
		state: 'pending',
		attempt: 1,
	})
})
it('requires password and single-use confirmation to change an email, preserving the old address until then', async () => {
	const a = await seed('alice'),
		bindings = { ...env, EMAIL: { send: async () => ({}) } as never }
	await env.DB.prepare("UPDATE accounts SET email='old@example.net',email_confirmed=1 WHERE id=?").bind(a.id).run()
	expect(
		(
			await request('/api/hyena/security/email', {
				cookie: a.cookie,
				headers: a.headers,
				method: 'POST',
				body: { password: 'wrong', email: 'new@example.net' },
				bindings,
			})
		).status
	).toBe(403)
	await json('/api/hyena/security/email', {
		cookie: a.cookie,
		headers: a.headers,
		method: 'POST',
		body: { password: a.password, email: 'new@example.net' },
		bindings,
	})
	expect((await one<{ email: string }>(env, 'SELECT email FROM accounts WHERE id=?', a.id))?.email).toBe(
		'old@example.net'
	)
	const job = await one<{ payload: string }>(env, "SELECT payload FROM jobs WHERE id LIKE 'email-change:%'")
	const link = JSON.parse(job!.payload).text.match(/https:\/\/\S+/)[0],
		path = new URL(link).pathname + new URL(link).search
	expect((await request(path)).status).toBe(200)
	expect((await one<{ email: string }>(env, 'SELECT email FROM accounts WHERE id=?', a.id))?.email).toBe(
		'new@example.net'
	)
	expect((await request(path)).status).toBe(422)
})
it('exposes maintenance health, rejects mutations, and repairs a revoked browser token', async () => {
	const a = await seed('alice'),
		session = await json<{ access_token: string }>('/api/hyena/session', { cookie: a.cookie })
	await env.DB.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE account_id=?').bind(Date.now(), a.id).run()
	const renewed = await json<{ access_token: string }>('/api/hyena/session', { cookie: a.cookie })
	expect(renewed.access_token).not.toBe(session.access_token)
	expect((await request('/api/v1/accounts/verify_credentials', { token: renewed.access_token })).status).toBe(200)
	const bindings = { ...env, MAINTENANCE_MODE: 'true' }
	expect(await json('/health/live', { bindings })).toMatchObject({ maintenance: true })
	expect(
		(
			await request('/api/v1/statuses', {
				token: renewed.access_token,
				method: 'POST',
				body: { status: 'must not write' },
				bindings,
			})
		).status
	).toBe(503)
	expect((await one<{ n: number }>(env, 'SELECT COUNT(*) n FROM statuses'))?.n).toBe(0)
})

it('records domain severance once, rejects new follows, exports only the owner records and preserves grouped payloads', async () => {
	const owner = await seed('owner', 'admin'),
		other = await seed('other'),
		remote = await seed('remote')
	await json('/api/v1/accounts/' + remote.id + '/follow', {
		token: owner.token,
		method: 'POST',
		body: { reblogs: false, languages: ['en'] },
	})
	await json('/api/v1/accounts/' + owner.id + '/follow', { token: remote.token, method: 'POST', body: {} })
	await env.DB.prepare(
		"UPDATE accounts SET domain='sub.example.net',uri='https://sub.example.net/users/remote' WHERE id=?"
	)
		.bind(remote.id)
		.run()
	expect(await (await request('/api/hyena/export/following.csv', { cookie: owner.cookie })).text()).toContain(
		'"remote@sub.example.net","false","false","en"'
	)
	await json('/api/v1/domain_blocks', { token: owner.token, method: 'POST', body: { domain: 'sub.example.net' } })
	expect(await one(env, 'SELECT 1 FROM follows WHERE follower_id=? OR following_id=?', remote.id, remote.id)).toBeNull()
	const events = await json<{ id: string; followers_count: number; following_count: number }[]>(
		'/api/hyena/severed_relationships',
		{ cookie: owner.cookie }
	)
	expect(events).toHaveLength(1)
	expect(events[0]).toMatchObject({ followers_count: 1, following_count: 1, type: 'user_domain_block' })
	const path = '/api/hyena/severed_relationships/' + events[0]!.id + '/following.csv'
	expect((await request(path, { cookie: other.cookie })).status).toBe(404)
	expect(await (await request(path, { cookie: owner.cookie })).text()).toContain(
		'"remote@sub.example.net","false","false","en"'
	)
	expect(
		(await request('/api/v1/accounts/' + remote.id + '/follow', { token: owner.token, method: 'POST', body: {} }))
			.status
	).toBe(422)
	await json('/api/v1/domain_blocks', { token: owner.token, method: 'POST', body: { domain: 'sub.example.net' } })
	expect(await all(env, 'SELECT * FROM relationship_events')).toHaveLength(1)
	const groups = await json<{ notification_groups: { type: string; event: { id: string } }[] }>(
		'/api/v2/notifications',
		{ token: owner.token }
	)
	expect(groups.notification_groups.find((n) => n.type === 'severed_relationships')?.event.id).toBe(events[0]!.id)
	await json('/api/v1/domain_blocks', { token: owner.token, method: 'DELETE', body: { domain: 'sub.example.net' } })
	expect(await one(env, 'SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', owner.id, remote.id)).toBeNull()
})

it('calculates real public link usage while excluding private and newly moderated sources', async () => {
	const owner = await seed('owner', 'admin'),
		remote = await seed('remote'),
		url = 'https://example.net/article'
	const card = { url, title: 'An article', type: 'link', provider_name: 'Example', provider_url: 'https://example.net' }
	await env.DB.prepare('INSERT INTO link_cards(url,data,approved,fetched_at) VALUES(?,?,1,?)')
		.bind(url, JSON.stringify(card), new Date().toISOString())
		.run()
	for (const [author, visibility] of [
		[owner, 'public'],
		[owner, 'private'],
		[remote, 'public'],
	] as const) {
		const s = await json<{ id: string }>('/api/v1/statuses', {
			token: author.token,
			method: 'POST',
			body: { status: 'a link', visibility },
		})
		await env.DB.prepare('UPDATE statuses SET card=? WHERE id=?').bind(JSON.stringify(card), s.id).run()
	}
	const read = () => json<{ history: { uses: string; accounts: string }[] }[]>('/api/v1/trends/links')
	expect((await read())[0]?.history[0]).toMatchObject({ uses: '2', accounts: '2' })
	await env.DB.prepare("UPDATE accounts SET domain='remote.example' WHERE id=?").bind(remote.id).run()
	await json('/api/v1/admin/domain_blocks', {
		token: owner.token,
		method: 'POST',
		body: { domain: 'remote.example', severity: 'silence' },
	})
	expect((await read())[0]?.history[0]).toMatchObject({ uses: '1', accounts: '1' })
})
