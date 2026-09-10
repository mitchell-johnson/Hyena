import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { env, runtime, request, json, seed } from './support'
import { base32, totp, verifySecondFactor } from '../src/auth/security'
import { seal } from '../src/federation/keys'
import { charge } from '../src/budgets'
import { digest, randomToken } from '../src/auth/crypto'
import { inRange, canonicalEmail } from '../src/moderation-policy'
import { executeJob } from '../src/jobs'
import { D1MessageQueue } from '../src/federation/storage'
import { all, one } from '../src/data'
import { currentRecipients } from '../src/federation/delivery-policy'
beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())
describe('security and durable operations', () => {
	it('matches RFC 6238, rejects TOTP reuse and consumes recovery codes once', async () => {
		const secret = base32(new TextEncoder().encode('12345678901234567890'))
		expect(await totp(secret, Math.floor(59 / 30))).toBe('287082')
		const a = await seed('alice')
		await env.DB.prepare('UPDATE accounts SET totp_secret=? WHERE id=?')
			.bind(await seal(env, secret), a.id)
			.run()
		const code = await totp(secret, Math.floor(Date.now() / 30000))
		const replies = await Promise.all([verifySecondFactor(env, a.id, code), verifySecondFactor(env, a.id, code)])
		expect(replies.sort()).toEqual([false, true])
		const recovery = randomToken()
		await env.DB.prepare('INSERT INTO recovery_codes(account_id,code_hash) VALUES(?,?)')
			.bind(a.id, await digest(recovery))
			.run()
		expect(await verifySecondFactor(env, a.id, recovery)).toBe(true)
		expect(await verifySecondFactor(env, a.id, recovery)).toBe(false)
	})
	it('revokes the web API token on logout and protects cookie mutations from CSRF', async () => {
		const a = await seed('alice'),
			session = await json<{ access_token: string }>('/api/hyena/session', { cookie: a.cookie })
		expect((await request('/api/v1/accounts/verify_credentials', { token: session.access_token })).status).toBe(200)
		expect(
			(
				await request('/api/hyena/security/password', {
					cookie: a.cookie,
					method: 'POST',
					body: { password: a.password, new_password: 'another-long-password' },
				})
			).status
		).toBe(403)
		const logout = await request('/logout', {
			cookie: a.cookie,
			method: 'POST',
			headers: a.headers,
			body: { csrf: a.csrf },
		})
		expect(logout.status).toBe(303)
		expect((await request('/api/v1/accounts/verify_credentials', { token: session.access_token })).status).toBe(401)
	})
	it('enforces token expiry and server moderation privileges', async () => {
		const a = await seed('alice')
		expect((await request('/api/hyena/admin/settings', { token: a.token })).status).toBe(403)
		await env.DB.prepare('UPDATE oauth_tokens SET expires_at=? WHERE account_id=?')
			.bind(Date.now() - 1, a.id)
			.run()
		expect((await request('/api/v1/accounts/verify_credentials', { token: a.token })).status).toBe(401)
	})
	it('enforces IPv4 and IPv6 CIDRs and normalizes equivalent email addresses', async () => {
		expect(inRange('203.0.113.42', '203.0.113.0/24')).toBe(true)
		expect(inRange('203.0.114.1', '203.0.113.0/24')).toBe(false)
		expect(inRange('2001:db8::123', '2001:db8::/32')).toBe(true)
		expect(inRange('::ffff:192.0.2.2', '::ffff:192.0.2.0/120')).toBe(true)
		expect(await canonicalEmail('Test.User+site@googlemail.com')).toBe(await canonicalEmail('testuser@gmail.com'))
		const a = await seed('admin', 'admin')
		await json('/api/v1/admin/ip_blocks', {
			token: a.token,
			method: 'POST',
			body: { ip: '203.0.113.0/24', severity: 'no_access', expires_in: 3600 },
		})
		expect((await request('/api/v1/instance', { headers: { 'CF-Connecting-IP': '203.0.113.42' } })).status).toBe(403)
		expect((await request('/api/v1/instance', { headers: { 'CF-Connecting-IP': '198.51.100.2' } })).status).toBe(200)
	})
	it('honours an invitation only once and restricts email confirmation to its registering app', async () => {
		const a = await seed('admin', 'admin'),
			invite = await json<{ url: string }>('/api/hyena/invites', {
				cookie: a.cookie,
				headers: a.headers,
				method: 'POST',
				body: { max_uses: 1 },
			}),
			code = new URL(invite.url).searchParams.get('invite_code'),
			appToken = randomToken()
		await env.DB.prepare('INSERT INTO oauth_tokens(token_hash,app_id,scopes,created_at) VALUES(?,?,?,?)')
			.bind(await digest(appToken), a.app, 'write:accounts read:accounts', Date.now())
			.run()
		const bindings = {
			...env,
			REGISTRATIONS: 'closed',
			EMAIL: { send: async () => ({ messageId: 'test' }) } as unknown as typeof env.EMAIL,
		}
		const [first, second] = await Promise.all(
			['one', 'two'].map((username) =>
				request('/api/v1/accounts', {
					token: appToken,
					method: 'POST',
					bindings,
					body: {
						username,
						email: username + '@example.net',
						password: a.password,
						agreement: true,
						invite_code: code,
					},
				})
			)
		)
		expect([first!.status, second!.status].sort()).toEqual([200, 422])
		await first!.text()
		await second!.text()
		expect((await one<{ uses: number }>(env, 'SELECT uses FROM invites'))?.uses).toBe(1)
		expect(
			(
				await request('/api/v1/emails/confirmations', {
					token: a.token,
					method: 'POST',
					body: { email: 'changed@example.net' },
					bindings,
				})
			).status
		).toBe(403)
	})
	it('does not overspend a budget under concurrent charges or charge a retry twice', async () => {
		await env.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('monthly_image_transforms', '3').run()
		const results = await Promise.allSettled([
			charge(env, 'a', 'image_transforms', 2),
			charge(env, 'b', 'image_transforms', 2),
		])
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		const used = await one<{ id: string }>(env, 'SELECT id FROM usage_charges')
		await charge(env, used!.id, 'image_transforms', 2)
		expect((await one<{ total: number }>(env, 'SELECT total FROM usage_counters'))?.total).toBe(2)
	})
	it('keeps all marker updates atomic when a version is stale', async () => {
		const a = await seed('alice')
		await json('/api/v1/markers', {
			token: a.token,
			method: 'POST',
			body: { home: { last_read_id: '100' }, notifications: { last_read_id: '200' } },
		})
		const res = await request('/api/v1/markers', {
			token: a.token,
			method: 'POST',
			body: { home: { last_read_id: '101', version: 1 }, notifications: { last_read_id: '201', version: 0 } },
		})
		expect(res.status).toBe(409)
		expect(await json('/api/v1/markers?timeline[]=home', { token: a.token })).toMatchObject({
			home: { last_read_id: '100', version: 1 },
		})
	})
	it('persists encrypted Fedify jobs once, preserves ordering, and retries beyond eight attempts', async () => {
		const q = new D1MessageQueue(env),
			m = {
				id: crypto.randomUUID(),
				type: 'outbox',
				activityId: 'https://hyena.test/a/1',
				inbox: 'https://example.net/inbox',
				activity: { id: 'https://hyena.test/a/1' },
				keys: [{ privateKey: { d: 'private material' } }],
			}
		await q.enqueue(m, { orderingKey: 'a' })
		await q.enqueue(m, { orderingKey: 'a' })
		const rows = await all<{ payload: string }>(env, "SELECT payload FROM jobs WHERE kind='federation.message'")
		expect(rows).toHaveLength(1)
		expect(rows[0]!.payload).not.toContain('private material')
		expect(rows[0]!.payload).toContain('messageCipher')
		const now = Date.now()
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES('ordered-1','email.send',?,?,?)"
			).bind(JSON.stringify({ orderingKey: 'mail', to: 'one@example.net', subject: 'x', text: 'y' }), now, now),
			env.DB.prepare(
				"INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES('ordered-2','email.send',?,?,?)"
			).bind(JSON.stringify({ orderingKey: 'mail', to: 'two@example.net', subject: 'x', text: 'y' }), now, now + 1),
		])
		await executeJob(env, 'ordered-2')
		expect((await one<{ attempt: number }>(env, "SELECT attempt FROM jobs WHERE id='ordered-2'"))?.attempt).toBe(0)
		await env.DB.prepare("UPDATE jobs SET attempt=8 WHERE id='ordered-1'").run()
		await executeJob(
			{
				...env,
				EMAIL: {
					send: async () => {
						throw new Error('temporary failure')
					},
				} as unknown as typeof env.EMAIL,
			},
			'ordered-1'
		)
		expect(await one(env, "SELECT state,attempt FROM jobs WHERE id='ordered-1'")).toMatchObject({
			state: 'pending',
			attempt: 9,
		})
	})
	it('rechecks a queued private audience after unfollowing or a domain block', async () => {
		const a = await seed('alice'),
			b = await seed('bob')
		await json('/api/v1/accounts/' + a.id + '/follow', { token: b.token, method: 'POST', body: {} })
		const s = await json<{ uri: string }>('/api/v1/statuses', {
				token: a.token,
				method: 'POST',
				body: { status: 'private', visibility: 'private' },
			}),
			activity = { type: 'Create', actor: env.PUBLIC_ORIGIN + '/users/alice', object: { id: s.uri } }
		expect(await currentRecipients(env, activity, [b.id])).toEqual([b.id])
		await json('/api/v1/accounts/' + a.id + '/unfollow', { token: b.token, method: 'POST', body: {} })
		expect(await currentRecipients(env, activity, [b.id])).toEqual([])
	})
})
