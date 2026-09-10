import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, describe } from 'vitest'
import { env, runtime, request, json, seed } from './support'
import { processExport } from '../src/lifecycle'
import { all, one } from '../src/data'
import { executeJob } from '../src/jobs'
import { tarHeader } from '../src/archive'
beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())
describe('community APIs and account portability', () => {
	it('enforces quote policy, emits authorization, and retracts a revoked quote', async () => {
		const a = await seed('alice'),
			b = await seed('bob'),
			s = await json<{ id: string }>('/api/v1/statuses', {
				token: a.token,
				method: 'POST',
				body: { status: 'Quote me', quote_approval_policy: 'followers' },
			})
		expect(
			(
				await request('/api/v1/statuses', {
					token: b.token,
					method: 'POST',
					body: { status: 'A quote', quoted_status_id: s.id },
				})
			).status
		).toBe(422)
		await json('/api/v1/accounts/' + a.id + '/follow', { token: b.token, method: 'POST', body: {} })
		const q = await json<{ id: string; quote: { state: string } }>('/api/v1/statuses', {
			token: b.token,
			method: 'POST',
			body: { status: 'A quote', quoted_status_id: s.id },
		})
		expect(q.quote.state).toBe('accepted')
		expect((await request('/quote_authorizations/' + q.id)).status).toBe(200)
		await json('/api/v1/statuses/' + s.id + '/quotes/' + q.id + '/revoke', { token: a.token, method: 'POST', body: {} })
		expect((await json<{ quote: { state: string } }>('/api/v1/statuses/' + q.id, { token: b.token })).quote.state).toBe(
			'revoked'
		)
		expect((await request('/quote_authorizations/' + q.id)).status).toBe(404)
	})
	it('creates a collection and allows only its featured account to revoke consent', async () => {
		const a = await seed('alice'),
			b = await seed('bob'),
			eve = await seed('eve'),
			result = await json<{ collection: { id: string } }>('/api/v1/collections', {
				token: a.token,
				method: 'POST',
				body: { name: 'Good people', description: 'People I recommend', discoverable: true },
			}),
			c = result.collection,
			item = await json<{ collection_item: { id: string; state: string } }>('/api/v1/collections/' + c.id + '/items', {
				token: a.token,
				method: 'POST',
				body: { account_id: b.id },
			})
		expect(item.collection_item.state).toBe('accepted')
		const doc = await json<{ type: string; orderedItems: unknown[] }>('/collections/' + c.id)
		expect(doc.type).toBe('FeaturedCollection')
		expect(doc.orderedItems).toHaveLength(1)
		expect(
			(
				await request('/api/v1/collections/' + c.id + '/items/' + item.collection_item.id + '/revoke', {
					token: eve.token,
					method: 'POST',
					body: {},
				})
			).status
		).toBe(404)
		await json('/api/v1/collections/' + c.id + '/items/' + item.collection_item.id + '/revoke', {
			token: b.token,
			method: 'POST',
			body: {},
		})
		const read = await json<{ collection: { items: { state: string }[] } }>('/api/v1/collections/' + c.id, {
			token: a.token,
		})
		expect(read.collection.items).toEqual([])
		expect(
			(await one<{ state: string }>(env, 'SELECT state FROM collection_items WHERE id=?', item.collection_item.id))
				?.state
		).toBe('revoked')
	})
	it('preserves notification v1 booleans and v2 policy values', async () => {
		const a = await seed('alice')
		const p = await json('/api/v1/notifications/policy', {
			token: a.token,
			method: 'PATCH',
			body: { filter_not_following: true, filter_bots: false },
		})
		expect(p).toMatchObject({ filter_not_following: true, filter_bots: false, summary: { pending_requests_count: 0 } })
		expect(p).not.toHaveProperty('for_not_following')
		const next = await json('/api/v2/notifications/policy', { token: a.token })
		expect(next.for_not_following).toBe('filter')
		expect(next.for_bots).toBe('accept')
	})
	it('creates announcements, rules, reports and moderation actions with a separate admin', async () => {
		const a = await seed('admin', 'admin'),
			b = await seed('bob'),
			s = await json<{ id: string }>('/api/v1/statuses', {
				token: b.token,
				method: 'POST',
				body: { status: 'A reported post' },
			})
		const n = await json<{ id: string; content: string }>('/api/hyena/admin/announcements', {
			token: a.token,
			method: 'POST',
			body: { content: '<p>Hello<script>alert(1)</script></p>' },
		})
		expect(n.content).toBe('<p>Hello</p>')
		await json('/api/v1/announcements/' + n.id + '/reactions/👍', { token: b.token, method: 'PUT', body: {} })
		await json('/api/hyena/admin/rules', {
			token: a.token,
			method: 'PUT',
			body: { rules: [{ text: 'Be kind', hint: 'Respect others' }] },
		})
		const report = await json<{ id: string }>('/api/v1/reports', {
			token: a.token,
			method: 'POST',
			body: { account_id: b.id, status_ids: [s.id], category: 'violation', rule_ids: ['1'], comment: 'Please review' },
		})
		const read = await json('/api/v1/admin/reports/' + report.id, { token: a.token })
		expect(read).toMatchObject({ id: report.id })
		await json('/api/v1/admin/reports/' + report.id + '/resolve', { token: a.token, method: 'POST', body: {} })
		expect((await json('/api/v1/admin/reports/' + report.id, { token: a.token })).action_taken).toBe(true)
	})
	it('exports private posts as a streaming archive protected by its owner session', async () => {
		const a = await seed('alice'),
			b = await seed('bob')
		await json('/api/v1/statuses', {
			token: a.token,
			method: 'POST',
			body: { status: 'Personal archive', visibility: 'private', poll: { options: ['yes', 'no'], expires_in: 3600 } },
		})
		const ex = await json<{ id: string }>('/api/hyena/exports', {
			cookie: a.cookie,
			headers: a.headers,
			method: 'POST',
			body: {},
		})
		await processExport(env, ex.id)
		expect((await one<{ status: string }>(env, 'SELECT status FROM account_exports WHERE id=?', ex.id))?.status).toBe(
			'ready'
		)
		expect((await request('/api/hyena/exports/' + ex.id + '/archive.tar', { cookie: b.cookie })).status).toBe(404)
		const response = await request('/api/hyena/exports/' + ex.id + '/archive.tar', { cookie: a.cookie }),
			bytes = new Uint8Array(await response.arrayBuffer())
		expect(response.status).toBe(200)
		expect(bytes.length % 512).toBe(0)
		const text = new TextDecoder().decode(bytes)
		expect(text).toContain('Personal archive')
		expect(text).not.toContain('private_keys')
		expect(text).not.toContain('password_hash')
		const header = tarHeader('test.json', 12, Date.now()),
			expected = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0),
			stored = parseInt(new TextDecoder().decode(header.slice(148, 154)), 8)
		expect(stored).toBe(expected)
	})
	it('imports Mastodon CSV and never returns another user’s import tasks', async () => {
		const a = await seed('alice'),
			b = await seed('bob')
		const task = await json<{ id: string }>('/api/hyena/imports', {
			cookie: a.cookie,
			headers: a.headers,
			method: 'POST',
			body: {
				type: 'following',
				mode: 'merge',
				data: 'Account address,Show boosts,Notify on new posts,Languages\r\nbob@hyena.test,true,true,en\r\n',
			},
		})
		await executeJob(env, 'import:' + task.id + ':0')
		expect(await json('/api/hyena/imports/' + task.id, { cookie: a.cookie })).toMatchObject({
			status: 'done',
			errors: [],
		})
		expect((await request('/api/hyena/imports/' + task.id, { cookie: b.cookie })).status).toBe(404)
		expect(await json('/api/v1/accounts/relationships?id[]=' + b.id, { token: a.token })).toMatchObject([
			{ following: true, notifying: true },
		])
	})
	it('preserves edit history and atomically cancels a scheduled post', async () => {
		const a = await seed('alice'),
			s = await json<{ id: string }>('/api/v1/statuses', {
				token: a.token,
				method: 'POST',
				body: { status: 'Original', poll: { options: ['one', 'two'], expires_in: 3600 } },
			})
		await json('/api/v1/statuses/' + s.id, {
			token: a.token,
			method: 'PUT',
			body: { status: 'Edited', poll: { options: ['new', 'options'], expires_in: 3600 } },
		})
		const history = await json<{ content: string; poll: { options: { title: string }[] } }[]>(
			'/api/v1/statuses/' + s.id + '/history',
			{ token: a.token }
		)
		expect(history.map((h) => h.content)).toEqual(['<p>Original</p>', '<p>Edited</p>'])
		expect(history[0]?.poll?.options[0]?.title).toBe('one')
		const scheduled = await json<{ id: string }>('/api/v1/statuses', {
			token: a.token,
			method: 'POST',
			body: { status: 'Never publish', scheduled_at: new Date(Date.now() + 600000).toISOString() },
		})
		await json('/api/v1/scheduled_statuses/' + scheduled.id, { token: a.token, method: 'DELETE' })
		await env.DB.prepare('UPDATE jobs SET available_at=? WHERE id=?')
			.bind(Date.now() - 1, 'schedule:' + scheduled.id)
			.run()
		await executeJob(env, 'schedule:' + scheduled.id)
		expect(await all(env, "SELECT id FROM statuses WHERE text='Never publish'")).toEqual([])
	})
})
