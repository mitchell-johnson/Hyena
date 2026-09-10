import { collectionJSON, type CollectionRow } from './collections'
import { Hono } from 'hono'
import { authenticate } from './auth/access'
import { nextId } from './db'
import { all, one, run, now, parsed, object, list, cursors, links, pageLimit } from './data'
import { ApiError, boolField, readInput } from './http'
import { accountJSON, statusJSON } from './serializers'
import { blocked, visible, audienceSQL } from './policy'
import { allowedAccountSQL, domainPolicy } from './moderation-policy'
import type { AccountRow, AppEnv, Env, StatusRow } from './types'

export const notifications = new Hono<AppEnv>()
export const notificationTable = `(SELECT * FROM notifications n WHERE EXISTS(SELECT 1 FROM accounts a WHERE a.id=n.from_account_id AND a.suspended=0 AND ${allowedAccountSQL()}) AND NOT EXISTS(SELECT 1 FROM account_actions b WHERE b.kind='block' AND ((b.account_id=n.account_id AND b.target_id=n.from_account_id) OR (b.target_id=n.account_id AND b.account_id=n.from_account_id))) AND NOT EXISTS(SELECT 1 FROM account_actions m WHERE m.account_id=n.account_id AND m.target_id=n.from_account_id AND m.kind='mute' AND COALESCE(json_extract(m.value,'$.notifications'),1)<>0 AND (m.expires_at IS NULL OR m.expires_at>unixepoch('subsec')*1000)) AND NOT EXISTS(SELECT 1 FROM user_domain_blocks d JOIN accounts a ON a.domain=d.domain WHERE d.account_id=n.account_id AND a.id=n.from_account_id) AND (n.status_id IS NULL OR EXISTS(SELECT 1 FROM statuses WHERE statuses.id=n.status_id AND ${audienceSQL(null).sql.replaceAll('?', 'n.account_id')})))`

export interface NotificationRow {
	id: string
	account_id: string
	from_account_id: string
	type: string
	status_id: string | null
	group_key: string
	request: number
	read: number
	dismissed: number
	created_at: string
	collection_id?: string | null
	details?: string
}
export const notificationTypes = [
	'mention',
	'status',
	'reblog',
	'follow',
	'follow_request',
	'favourite',
	'poll',
	'update',
	'admin.sign_up',
	'admin.report',
	'severed_relationships',
	'moderation_warning',
	'quote',
	'quoted_update',
	'added_to_collection',
	'collection_update',
]
const defaultPolicy = {
	for_not_following: 'accept',
	for_not_followers: 'accept',
	for_new_accounts: 'accept',
	for_private_mentions: 'accept',
	for_limited_accounts: 'filter',
	for_bots: 'accept',
}
export async function notificationStatements(
	env: Env,
	to: string,
	from: string,
	type: string,
	statusId: string | null,
	eventKey: string,
	guard?: { sql: string; binds: (string | number | null)[] },
	collectionId: string | null = null
): Promise<D1PreparedStatement[]> {
	if (to === from && !['poll', 'severed_relationships', 'moderation_warning'].includes(type)) return []
	const target = await one<AccountRow>(env, 'SELECT * FROM accounts WHERE id=?', to),
		actor = await one<AccountRow>(env, 'SELECT * FROM accounts WHERE id=?', from)
	if (!target || target.domain || target.suspended || !actor || actor.suspended || (await blocked(env, to, from)))
		return []
	const domain = actor.domain ? await domainPolicy(env, actor.domain) : null
	if (
		domain?.suspended ||
		(await one(env, 'SELECT 1 FROM user_domain_blocks WHERE account_id=? AND domain=?', to, actor.domain ?? ''))
	)
		return []
	const mute = await one<{ value: string }>(
		env,
		"SELECT value FROM account_actions WHERE account_id=? AND target_id=? AND kind='mute' AND (expires_at IS NULL OR expires_at>?)",
		to,
		from,
		Date.now()
	)
	if (mute && parsed<Record<string, unknown>>(mute.value, {}).notifications !== false) return []
	if (
		statusId &&
		(await one(env, "SELECT 1 FROM interactions WHERE account_id=? AND status_id=? AND kind='mute'", to, statusId))
	)
		return []
	const policy = {
		...defaultPolicy,
		...parsed<Record<string, string>>(
			(await one<{ policy: string }>(env, 'SELECT policy FROM notification_policies WHERE account_id=?', to))?.policy,
			{}
		),
	}
	const checks = [
		actor.bot ? policy.for_bots : null,
		actor.silenced || domain?.limited ? policy.for_limited_accounts : null,
		Date.parse(actor.created_at) > Date.now() - 30 * 86400000 ? policy.for_new_accounts : null,
	]
	if (!(await one(env, "SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'", to, from)))
		checks.push(policy.for_not_following)
	if (!(await one(env, "SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'", from, to)))
		checks.push(policy.for_not_followers)
	if (
		type === 'mention' &&
		statusId &&
		(await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', statusId))?.visibility === 'direct'
	)
		checks.push(policy.for_private_mentions)
	const system = ['severed_relationships', 'moderation_warning', 'admin.report', 'admin.sign_up'].includes(type)
	if (!system && checks.includes('drop')) return []
	const request = !system && checks.includes('filter') ? 1 : 0,
		id = await nextId(env.DB),
		group = `${type}-${statusId ?? from}`
	return [
		env.DB.prepare(
			`INSERT OR IGNORE INTO notifications(id,account_id,from_account_id,type,status_id,group_key,request,created_at,event_key,collection_id) SELECT ?,?,?,?,?,?,?,?,?,? ${guard ? 'WHERE ' + guard.sql : ''}`
		).bind(id, to, from, type, statusId, group, request, now(), eventKey, collectionId, ...(guard?.binds ?? [])),
		env.DB.prepare(
			`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'notification.push',?,?,? WHERE EXISTS(SELECT 1 FROM notifications WHERE id=? AND request=0)`
		).bind('notification:' + id, JSON.stringify({ notificationId: id }), Date.now(), Date.now(), id),
	]
}
export async function notificationJSON(env: Env, n: NotificationRow) {
	const a = await one<AccountRow>(env, 'SELECT * FROM accounts WHERE id=?', n.from_account_id)
	const details = parsed<Record<string, unknown>>(n.details, {})
	if (n.type === 'severed_relationships' && typeof details.event_id === 'string') {
		const event = await one<import('./severance').RelationshipEvent>(
			env,
			'SELECT * FROM relationship_events WHERE id=? AND account_id=?',
			details.event_id,
			n.account_id
		)
		if (event) details.event = await (await import('./severance')).relationshipEventJSON(env, event)
		delete details.event_id
	}
	if (n.type === 'admin.report' && typeof details.report_id === 'string') {
		const report = await one<import('./admin').Report>(env, 'SELECT * FROM reports WHERE id=?', details.report_id)
		if (report) details.report = await (await import('./admin')).reportJSON(env, report)
		delete details.report_id
	}
	const s = n.status_id ? await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', n.status_id) : null
	return {
		id: n.id,
		group_key: n.group_key,
		...(n.request ? { filtered: true } : {}),
		...details,
		type: n.type,
		created_at: n.created_at,
		account: a ? await accountJSON(env, a) : null,
		...(n.collection_id
			? {
					collection: await collectionJSON(
						env,
						(await one<CollectionRow>(env, 'SELECT * FROM collections WHERE id=?', n.collection_id))!,
						n.account_id
					),
				}
			: {}),
		...(s && (await visible(env, s, n.account_id))
			? { status: await statusJSON(env, s, n.account_id, 0, 'notifications') }
			: {}),
	}
}
function policyJSON(version: string, policy: Record<string, unknown>) {
	const p = { ...defaultPolicy, ...policy }
	return version === 'v1'
		? Object.fromEntries(
				['not_following', 'not_followers', 'new_accounts', 'private_mentions', 'bots'].map((k) => [
					'filter_' + k,
					p[('for_' + k) as keyof typeof p] !== 'accept',
				])
			)
		: p
}
for (const v of ['v1', 'v2']) {
	notifications.get(`/api/${v}/notifications/policy`, async (c) => {
		await authenticate(c, 'read:notifications')
		const owner = c.get('account').id,
			p = parsed<Record<string, string>>(
				(await one<{ policy: string }>(c.env, 'SELECT policy FROM notification_policies WHERE account_id=?', owner))
					?.policy,
				{}
			)
		const count = await one<{ accounts: number; notifications: number }>(
			c.env,
			`SELECT COUNT(DISTINCT from_account_id) accounts,COUNT(*) notifications FROM ${notificationTable} notifications WHERE account_id=? AND request=1 AND dismissed=0`,
			owner
		)
		return c.json({
			...policyJSON(v, p),
			summary: { pending_requests_count: count?.accounts ?? 0, pending_notifications_count: count?.notifications ?? 0 },
		})
	})
	notifications.patch(`/api/${v}/notifications/policy`, async (c) => {
		await authenticate(c, 'write:notifications')
		const input = await readInput(c.req.raw),
			p = parsed<Record<string, unknown>>(
				(
					await one<{ policy: string }>(
						c.env,
						'SELECT policy FROM notification_policies WHERE account_id=?',
						c.get('account').id
					)
				)?.policy,
				{}
			)
		for (let [key, value] of Object.entries(input)) {
			if (v === 'v1') {
				if (
					![
						'filter_not_following',
						'filter_not_followers',
						'filter_new_accounts',
						'filter_private_mentions',
						'filter_bots',
					].includes(key)
				)
					throw new ApiError(422, 'Invalid notification policy')
				value = boolField(input, key) ? 'filter' : 'accept'
				key = key.replace('filter_', 'for_')
			}
			if (!(key in defaultPolicy) || !['accept', 'filter', 'drop'].includes(String(value)))
				throw new ApiError(422, 'Invalid notification policy')
			p[key] = value
		}
		await run(
			c.env,
			'INSERT INTO notification_policies(account_id,policy) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET policy=excluded.policy',
			c.get('account').id,
			JSON.stringify(p)
		)
		const counts = await one<{ accounts: number; notifications: number }>(
			c.env,
			`SELECT COUNT(DISTINCT from_account_id) accounts,COUNT(*) notifications FROM ${notificationTable} notifications WHERE account_id=? AND request=1 AND dismissed=0`,
			c.get('account').id
		)
		return c.json({
			...policyJSON(v, p),
			summary: {
				pending_requests_count: counts?.accounts ?? 0,
				pending_notifications_count: counts?.notifications ?? 0,
			},
		})
	})
	notifications.post(`/api/${v}/notifications/clear`, async (c) => {
		await authenticate(c, 'write:notifications')
		await run(c.env, 'UPDATE notifications SET dismissed=1 WHERE account_id=?', c.get('account').id)
		return c.json({})
	})
	notifications.get(`/api/${v}/notifications/unread_count`, async (c) => {
		await authenticate(c, 'read:notifications')
		const marker = await one<{ last_read_id: string }>(
			c.env,
			"SELECT last_read_id FROM markers WHERE account_id=? AND timeline='notifications'",
			c.get('account').id
		)
		return c.json({
			count:
				(
					await one<{ n: number }>(
						c.env,
						`SELECT COUNT(*) n FROM ${notificationTable} notifications WHERE account_id=? AND dismissed=0 AND request=0 AND read=0 AND CAST(id AS INTEGER)>CAST(? AS INTEGER)`,
						c.get('account').id,
						marker?.last_read_id ?? '0'
					)
				)?.n ?? 0,
		})
	})
	notifications.post(`/api/${v}/notifications/:id/dismiss`, async (c) => {
		await authenticate(c, 'write:notifications')
		await run(
			c.env,
			`UPDATE notifications SET dismissed=1 WHERE account_id=? AND ${v === 'v1' ? 'id' : 'group_key'}=?`,
			c.get('account').id,
			c.req.param('id')!
		)
		return c.json({})
	})
}
notifications.get('/api/v1/notifications/requests', async (c) => {
	await authenticate(c, 'read:notifications')
	const rows = await all<{ from_account_id: string; id: string; count: number; last: string }>(
		c.env,
		`SELECT from_account_id,MIN(id) id,COUNT(*) count,MAX(id) last FROM ${notificationTable} notifications WHERE account_id=? AND request=1 AND dismissed=0 GROUP BY from_account_id ORDER BY CAST(last AS INTEGER) DESC LIMIT ?`,
		c.get('account').id,
		pageLimit(c)
	)
	return c.json(
		await Promise.all(
			rows.map(async (r) => ({
				id: r.from_account_id,
				account: await accountJSON(
					c.env,
					(await one<AccountRow>(c.env, 'SELECT * FROM accounts WHERE id=?', r.from_account_id))!
				),
				notifications_count: String(r.count),
				last_status: (await one<NotificationRow>(c.env, 'SELECT * FROM notifications WHERE id=?', r.last))?.status_id
					? ((
							await notificationJSON(
								c.env,
								(await one<NotificationRow>(c.env, 'SELECT * FROM notifications WHERE id=?', r.last))!
							)
						).status ?? null)
					: null,
			}))
		)
	)
})
notifications.get('/api/v1/notifications/requests/merged', async (c) => {
	await authenticate(c, 'read:notifications')
	return c.json({
		merged: !(await one(
			c.env,
			`SELECT 1 FROM ${notificationTable} notifications WHERE account_id=? AND request=1 AND dismissed=0 LIMIT 1`,
			c.get('account').id
		)),
	})
})
notifications.get('/api/v1/notifications/requests/:id', async (c) => {
	await authenticate(c, 'read:notifications')
	const rows = await all<NotificationRow>(
		c.env,
		`SELECT * FROM ${notificationTable} notifications WHERE account_id=? AND from_account_id=? AND request=1 AND dismissed=0`,
		c.get('account').id,
		c.req.param('id')!
	)
	if (!rows.length) throw new ApiError(404, 'Record not found')
	return c.json({
		id: c.req.param('id')!,
		account: (await notificationJSON(c.env, rows[0]!)).account,
		notifications_count: String(rows.length),
		last_status: (await notificationJSON(c.env, rows.at(-1)!)).status ?? null,
	})
})
for (const action of ['accept', 'dismiss']) {
	notifications.post('/api/v1/notifications/requests/:id/' + action, async (c) => {
		await authenticate(c, 'write:notifications')
		await run(
			c.env,
			`UPDATE notifications SET ${action === 'accept' ? 'request=0' : 'dismissed=1'} WHERE account_id=? AND from_account_id=? AND request=1`,
			c.get('account').id,
			c.req.param('id')!
		)
		return c.json({})
	})
	notifications.post('/api/v1/notifications/requests/' + action, async (c) => {
		await authenticate(c, 'write:notifications')
		const ids = list((await readInput(c.req.raw)).id, 100)
		if (ids.length)
			await c.env.DB.batch(
				ids.map((id) =>
					c.env.DB.prepare(
						`UPDATE notifications SET ${action === 'accept' ? 'request=0' : 'dismissed=1'} WHERE account_id=? AND from_account_id=? AND request=1`
					).bind(c.get('account').id, id)
				)
			)
		return c.json({})
	})
}
notifications.get('/api/v1/notifications', async (c) => {
	await authenticate(c, 'read:notifications')
	const cur = cursors(c),
		include = c.req.queries('types[]') ?? [],
		exclude = c.req.queries('exclude_types[]') ?? [],
		from = c.req.query('account_id'),
		clauses = [],
		binds: (string | number)[] = []
	for (const [types, op] of [
		[include, 'IN'],
		[exclude, 'NOT IN'],
	] as const) {
		if (types.some((t) => !notificationTypes.includes(t))) throw new ApiError(422, 'Invalid notification type')
		if (types.length) {
			clauses.push(`type ${op} (${types.map(() => '?').join(',')})`)
			binds.push(...types)
		}
	}
	if (from) {
		clauses.push('from_account_id=?')
		binds.push(from)
	}
	const rows = await all<NotificationRow>(
		c.env,
		`SELECT * FROM ${notificationTable} notifications WHERE account_id=? AND dismissed=0 AND request=0 ${cur.sql} ${clauses.length ? 'AND ' + clauses.join(' AND ') : ''} ORDER BY CAST(id AS INTEGER) ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
		c.get('account').id,
		...cur.binds,
		...binds,
		pageLimit(c)
	)
	if (cur.ascending) rows.reverse()
	links(c, rows)
	return c.json(await Promise.all(rows.map((n) => notificationJSON(c.env, n))))
})
notifications.get('/api/v1/notifications/:id', async (c) => {
	await authenticate(c, 'read:notifications')
	const n = await one<NotificationRow>(
		c.env,
		`SELECT * FROM ${notificationTable} notifications WHERE id=? AND account_id=? AND dismissed=0`,
		c.req.param('id')!,
		c.get('account').id
	)
	if (!n) throw new ApiError(404, 'Record not found')
	return c.json(await notificationJSON(c.env, n))
})
async function grouped(env: Env, owner: string, key?: string, limit = 20, query?: URLSearchParams) {
	const clauses: string[] = [],
		binds: (string | number)[] = []
	for (const [param, op] of [
		['types[]', 'IN'],
		['exclude_types[]', 'NOT IN'],
	] as const) {
		const types = query?.getAll(param) ?? []
		if (types.length) {
			clauses.push(`type ${op} (${types.map(() => '?').join(',')})`)
			binds.push(...types)
		}
	}
	if (query?.get('account_id')) {
		clauses.push('from_account_id=?')
		binds.push(query.get('account_id')!)
	}
	const having: string[] = [],
		cursorBinds: string[] = []
	for (const [key, op] of [
		['max_id', '<'],
		['since_id', '>'],
		['min_id', '>'],
	] as const) {
		const id = query?.get(key)
		if (id) {
			having.push(`CAST(MAX(id) AS INTEGER)${op}CAST(? AS INTEGER)`)
			cursorBinds.push(id)
		}
	}
	const ascending = !!query?.get('min_id')
	const groups = await all<{ group_key: string; newest: string; oldest: string; n: number }>(
		env,
		`SELECT group_key,MAX(id) newest,MIN(id) oldest,COUNT(*) n FROM ${notificationTable} notifications WHERE account_id=? AND dismissed=0 AND request=0 ${key ? 'AND group_key=?' : ''} ${clauses.length ? 'AND ' + clauses.join(' AND ') : ''} GROUP BY group_key ${having.length ? 'HAVING ' + having.join(' AND ') : ''} ORDER BY CAST(newest AS INTEGER) ${ascending ? 'ASC' : 'DESC'} LIMIT ?`,
		owner,
		...(key ? [key] : []),
		...binds,
		...cursorBinds,
		limit
	)
	if (ascending) groups.reverse()
	const accounts = new Map<string, Awaited<ReturnType<typeof accountJSON>>>(),
		statuses = new Map<string, Awaited<ReturnType<typeof statusJSON>>>(),
		notifications = []
	for (const g of groups) {
		const items = await all<NotificationRow>(
				env,
				`SELECT * FROM ${notificationTable} notifications WHERE account_id=? AND group_key=? AND dismissed=0 AND request=0 ORDER BY CAST(id AS INTEGER) DESC LIMIT 8`,
				owner,
				g.group_key
			),
			first = items[0]!
		for (const item of items) {
			const n = await notificationJSON(env, item)
			if (n.account) accounts.set(n.account.id, n.account)
			if (n.status) statuses.set(n.status.id, n.status)
		}
		const detail: Record<string, unknown> = await notificationJSON(env, first)
		notifications.push({
			...Object.fromEntries(
				['event', 'moderation_warning', 'report', 'collection']
					.filter((key) => detail[key] !== undefined)
					.map((key) => [key, detail[key]])
			),
			group_key: g.group_key,
			notifications_count: g.n,
			type: first.type,
			most_recent_notification_id: g.newest,
			oldest_notification_id: g.oldest,
			latest_page_notification_at: first.created_at,
			sample_account_ids: [...new Set(items.map((n) => n.from_account_id))],
			status_id: first.status_id,
		})
	}
	return { accounts: [...accounts.values()], statuses: [...statuses.values()], notification_groups: notifications }
}
notifications.get('/api/v2/notifications', async (c) => {
	await authenticate(c, 'read:notifications')
	const data = await grouped(c.env, c.get('account').id, undefined, pageLimit(c), new URL(c.req.url).searchParams)
	links(
		c,
		data.notification_groups.map((n) => ({ id: n.most_recent_notification_id }))
	)
	return c.json(data)
})
notifications.get('/api/v2/notifications/:key/accounts', async (c) => {
	await authenticate(c, 'read:notifications')
	const rows = await all<AccountRow>(
		c.env,
		`SELECT DISTINCT a.* FROM accounts a JOIN ${notificationTable} n ON n.from_account_id=a.id WHERE n.account_id=? AND n.group_key=? AND n.dismissed=0 LIMIT ?`,
		c.get('account').id,
		c.req.param('key'),
		pageLimit(c)
	)
	return c.json(await Promise.all(rows.map((a) => accountJSON(c.env, a))))
})
notifications.get('/api/v2/notifications/:key', async (c) => {
	await authenticate(c, 'read:notifications')
	const data = await grouped(c.env, c.get('account').id, c.req.param('key'))
	if (!data.notification_groups.length) throw new ApiError(404, 'Record not found')
	return c.json({ ...data, notification_group: data.notification_groups[0] })
})
