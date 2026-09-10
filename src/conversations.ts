import { Hono } from 'hono'
import { authenticate } from './auth/access'
import { all, one, run, now, object, cursors, pageLimit, links } from './data'
import { ApiError, readInput, stringField } from './http'
import { accountJSON, statusJSON } from './serializers'
import { visible } from './policy'
import type { AccountRow, AppEnv, Env, StatusRow } from './types'
import { isId } from './db'
export const conversations = new Hono<AppEnv>()
export async function conversationJSON(env: Env, id: string, owner: string) {
	const row = await one<{ id: string; last_status_id: string; unread: number }>(
		env,
		'SELECT * FROM conversations WHERE id=? AND account_id=? AND deleted=0',
		id,
		owner
	)
	if (!row) throw new ApiError(404, 'Record not found')
	const last = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', row.last_status_id),
		accounts = await all<AccountRow>(
			env,
			'SELECT DISTINCT a.* FROM accounts a JOIN conversations c ON c.account_id=a.id WHERE c.id=? AND a.id<>?',
			id,
			owner
		)
	return {
		id,
		unread: !!row.unread,
		accounts: await Promise.all(accounts.map((a) => accountJSON(env, a))),
		last_status: last && (await visible(env, last, owner)) ? await statusJSON(env, last, owner) : null,
	}
}
conversations.get('/api/v1/conversations', async (c) => {
	await authenticate(c, 'read:statuses')
	const cur = cursors(c, 'last_status_id'),
		rows = await all<{ id: string; last_status_id: string }>(
			c.env,
			`SELECT id,last_status_id FROM conversations WHERE account_id=? AND deleted=0 ${cur.sql} ORDER BY CAST(last_status_id AS INTEGER) ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
			c.get('account').id,
			...cur.binds,
			pageLimit(c)
		)
	if (cur.ascending) rows.reverse()
	links(
		c,
		rows.map((r) => ({ id: r.last_status_id }))
	)
	return c.json(await Promise.all(rows.map((r) => conversationJSON(c.env, r.id, c.get('account').id))))
})
for (const action of ['read', 'unread'] as const)
	conversations.post('/api/v1/conversations/:id/' + action, async (c) => {
		await authenticate(c, 'write:conversations')
		await conversationJSON(c.env, c.req.param('id')!, c.get('account').id)
		await run(
			c.env,
			'UPDATE conversations SET unread=? WHERE id=? AND account_id=?',
			action === 'unread' ? 1 : 0,
			c.req.param('id')!,
			c.get('account').id
		)
		return c.json(await conversationJSON(c.env, c.req.param('id')!, c.get('account').id))
	})
conversations.delete('/api/v1/conversations/:id', async (c) => {
	await authenticate(c, 'write:conversations')
	await conversationJSON(c.env, c.req.param('id'), c.get('account').id)
	await run(
		c.env,
		'UPDATE conversations SET deleted=1 WHERE id=? AND account_id=?',
		c.req.param('id'),
		c.get('account').id
	)
	return c.json({})
})
conversations.get('/api/v1/markers', async (c) => {
	await authenticate(c, 'read:statuses')
	const timelines = c.req.queries('timeline[]') ?? [],
		result: Record<string, unknown> = {}
	if (timelines.some((t) => !['home', 'notifications'].includes(t))) throw new ApiError(422, 'Invalid marker timeline')
	for (const timeline of timelines) {
		const r = await one<{ last_read_id: string; version: number; updated_at: string }>(
			c.env,
			'SELECT last_read_id,version,updated_at FROM markers WHERE account_id=? AND timeline=?',
			c.get('account').id,
			timeline
		)
		if (r) result[timeline] = r
	}
	return c.json(result)
})
conversations.post('/api/v1/markers', async (c) => {
	await authenticate(c, 'write:statuses')
	const input = await readInput(c.req.raw),
		owner = c.get('account').id,
		statements: D1PreparedStatement[] = [],
		timelines = Object.keys(input)
	if (timelines.some((t) => !['home', 'notifications'].includes(t))) throw new ApiError(422, 'Invalid marker timeline')
	const guardId = crypto.randomUUID(),
		checks: string[] = [],
		checkBinds: (string | number)[] = []
	for (const timeline of timelines) {
		const value = object(input[timeline]),
			id = stringField(value, 'last_read_id')
		if (!isId(id)) throw new ApiError(422, 'Invalid marker ID')
		const current = await one<{ version: number }>(
				c.env,
				'SELECT version FROM markers WHERE account_id=? AND timeline=?',
				owner,
				timeline
			),
			version = value.version === undefined ? (current?.version ?? 0) : Number(value.version)
		if (!Number.isInteger(version) || version !== (current?.version ?? 0)) throw new ApiError(409, 'Marker has changed')
		checks.push('(COALESCE((SELECT version FROM markers WHERE account_id=? AND timeline=?),0)=?)')
		checkBinds.push(owner, timeline, version)
		statements.push(
			c.env.DB.prepare(
				'INSERT INTO markers(account_id,timeline,last_read_id,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(account_id,timeline) DO UPDATE SET last_read_id=excluded.last_read_id,version=markers.version+1,updated_at=excluded.updated_at WHERE markers.version=?'
			).bind(owner, timeline, id, now(), version)
		)
	}
	if (statements.length) {
		let changes
		try {
			changes = (
				await c.env.DB.batch([
					c.env.DB.prepare(
						`INSERT INTO transaction_guards VALUES(?,CASE WHEN ${checks.join(' AND ')} THEN 1 ELSE 0 END)`
					).bind(guardId, ...checkBinds),
					...statements,
					c.env.DB.prepare('DELETE FROM transaction_guards WHERE id=?').bind(guardId),
				])
			).slice(1, -1)
		} catch (error) {
			if (String(error).includes('CHECK constraint failed')) throw new ApiError(409, 'Marker has changed')
			throw error
		}
		if (changes.some((r) => !r.meta.changes)) throw new ApiError(409, 'Marker has changed')
	}
	const result: Record<string, unknown> = {}
	for (const t of timelines)
		result[t] = await one(
			c.env,
			'SELECT last_read_id,version,updated_at FROM markers WHERE account_id=? AND timeline=?',
			owner,
			t
		)
	return c.json(result)
})
