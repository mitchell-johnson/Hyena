import { Hono } from 'hono'
import { authenticate, optionalAccount } from './auth/access'
import { nextId } from './db'
import { accountById, accountUri, all, one, run, parsed, now, list, object, pageLimit, cursors, links } from './data'
import { ApiError, boolField, readInput, stringField } from './http'
import { accountJSON } from './serializers'
import { blocked } from './policy'
import { outboundStatement } from './federation/outbox'
import { notificationStatements } from './notifications'
import { severanceStatements } from './severance'
import { domainPolicy } from './moderation-policy'
import type { AccountRow, AppEnv, Env } from './types'

export const social = new Hono<AppEnv>()
interface FollowRow {
	id: string
	follower_id: string
	following_id: string
	state: string
	reblogs: number
	notify: number
	languages: string
	activity_uri: string
}
export async function relationship(env: Env, owner: string, target: string) {
	const follows = await all<FollowRow>(
		env,
		'SELECT * FROM follows WHERE (follower_id=? AND following_id=?) OR (following_id=? AND follower_id=?)',
		owner,
		target,
		owner,
		target
	)
	const f = follows.find((f) => f.follower_id === owner),
		r = follows.find((f) => f.follower_id === target)
	const actions = await all<{ kind: string; account_id: string; value: string }>(
		env,
		'SELECT kind,account_id,value FROM account_actions WHERE ((account_id=? AND target_id=?) OR (account_id=? AND target_id=?)) AND (expires_at IS NULL OR expires_at>?)',
		owner,
		target,
		target,
		owner,
		Date.now()
	)
	const action = (kind: string) => actions.find((a) => a.account_id === owner && a.kind === kind)
	const a = await accountById(env, target)
	return {
		id: target,
		following: f?.state === 'accepted',
		showing_reblogs: f ? !!f.reblogs : false,
		notifying: !!f?.notify,
		languages: parsed<string[]>(f?.languages, []),
		followed_by: r?.state === 'accepted',
		blocking: !!action('block'),
		blocked_by: actions.some((a) => a.account_id === target && a.kind === 'block'),
		muting: !!action('mute'),
		muting_notifications:
			!!action('mute') && parsed<Record<string, unknown>>(action('mute')?.value, {}).notifications !== false,
		requested: f?.state === 'pending',
		requested_by: r?.state === 'pending',
		domain_blocking: !!(await one(
			env,
			'SELECT 1 FROM user_domain_blocks WHERE account_id=? AND domain=?',
			owner,
			a.domain ?? ''
		)),
		endorsed: !!action('endorse'),
		note: parsed<Record<string, unknown>>(action('note')?.value, {}).comment ?? '',
	}
}
social.get('/api/v1/accounts/relationships', async (c) => {
	await authenticate(c, 'read:follows')
	const ids = c.req.queries('id[]') ?? c.req.queries('id') ?? []
	if (ids.length > 100) throw new ApiError(422, 'Too many accounts')
	return c.json(await Promise.all(ids.map((id) => relationship(c.env, c.get('account').id, id))))
})
social.get('/api/v1/accounts/familiar_followers', async (c) => {
	await authenticate(c, 'read:follows')
	const owner = c.get('account').id,
		ids = c.req.queries('id[]') ?? []
	return c.json(
		await Promise.all(
			ids.slice(0, 100).map(async (id) => ({
				id,
				accounts: await Promise.all(
					(
						await all<AccountRow>(
							c.env,
							`SELECT a.* FROM accounts a JOIN follows f ON f.follower_id=a.id WHERE f.following_id=? AND f.state='accepted' AND EXISTS(SELECT 1 FROM follows mine WHERE mine.follower_id=? AND mine.following_id=a.id AND mine.state='accepted') LIMIT 80`,
							id,
							owner
						)
					).map((a) => accountJSON(c.env, a))
				),
			}))
		)
	)
})
social.get('/api/v1/accounts', async (c) => {
	const ids = c.req.queries('id[]') ?? []
	if (ids.length > 100) throw new ApiError(422, 'Too many accounts')
	return c.json(await Promise.all(ids.map(async (id) => accountJSON(c.env, await accountById(c.env, id)))))
})

social.post('/api/v1/accounts/:id/follow', async (c) => {
	await authenticate(c, 'write:follows')
	const a = c.get('account'),
		target = await accountById(c.env, c.req.param('id')!)
	if (a.id === target.id || target.suspended || (await blocked(c.env, a.id, target.id)))
		throw new ApiError(422, 'This account cannot be followed')
	if (
		target.domain &&
		((await domainPolicy(c.env, target.domain)).suspended ||
			(await one(c.env, 'SELECT 1 FROM user_domain_blocks WHERE account_id=? AND domain=?', a.id, target.domain)))
	)
		throw new ApiError(422, 'This domain is blocked')
	const input = await readInput(c.req.raw),
		existing = await one<FollowRow>(
			c.env,
			'SELECT * FROM follows WHERE follower_id=? AND following_id=?',
			a.id,
			target.id
		),
		id = existing?.id ?? (await nextId(c.env.DB)),
		uri = existing?.activity_uri ?? `${c.env.PUBLIC_ORIGIN}/activities/${crypto.randomUUID()}`
	const state = existing?.state ?? (target.domain || target.locked ? 'pending' : 'accepted'),
		reblogs = boolField(input, 'reblogs', existing ? !!existing.reblogs : true),
		notify = boolField(input, 'notify', !!existing?.notify),
		languages = input.languages === undefined ? parsed<string[]>(existing?.languages, []) : list(input.languages, 20)
	const statements = [
		c.env.DB.prepare(
			`INSERT INTO follows(id,follower_id,following_id,state,reblogs,notify,languages,activity_uri,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(follower_id,following_id) DO UPDATE SET reblogs=excluded.reblogs,notify=excluded.notify,languages=excluded.languages`
		).bind(id, a.id, target.id, state, +reblogs, +notify, JSON.stringify(languages), uri, now()),
	]
	if (!existing) {
		statements.push(
			outboundStatement(
				c.env,
				a.id,
				{ id: uri, type: 'Follow', actor: accountUri(c.env, a), object: accountUri(c.env, target) },
				[target.id]
			)
		)
		statements.push(
			...(await notificationStatements(
				c.env,
				target.id,
				a.id,
				state === 'pending' ? 'follow_request' : 'follow',
				null,
				'follow:' + id
			))
		)
	}
	await c.env.DB.batch(statements)
	return c.json(await relationship(c.env, a.id, target.id))
})
social.post('/api/v1/accounts/:id/unfollow', async (c) => {
	await authenticate(c, 'write:follows')
	const a = c.get('account'),
		target = await accountById(c.env, c.req.param('id')!),
		f = await one<FollowRow>(c.env, 'SELECT * FROM follows WHERE follower_id=? AND following_id=?', a.id, target.id)
	if (f)
		await c.env.DB.batch([
			c.env.DB.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').bind(a.id, target.id),
			c.env.DB.prepare(
				'DELETE FROM list_accounts WHERE account_id=? AND list_id IN (SELECT id FROM lists WHERE account_id=?)'
			).bind(target.id, a.id),
			outboundStatement(
				c.env,
				a.id,
				{
					type: 'Undo',
					actor: accountUri(c.env, a),
					object: {
						id: f.activity_uri,
						type: 'Follow',
						actor: accountUri(c.env, a),
						object: accountUri(c.env, target),
					},
				},
				[target.id]
			),
		])
	return c.json(await relationship(c.env, a.id, target.id))
})
for (const action of ['authorize', 'reject'] as const)
	social.post('/api/v1/follow_requests/:id/' + action, async (c) => {
		await authenticate(c, 'write:follows')
		const a = c.get('account'),
			target = await accountById(c.env, c.req.param('id')!),
			f = await one<FollowRow>(
				c.env,
				"SELECT * FROM follows WHERE follower_id=? AND following_id=? AND state='pending'",
				target.id,
				a.id
			)
		if (!f) throw new ApiError(404, 'Follow request not found')
		await c.env.DB.batch([
			action === 'authorize'
				? c.env.DB.prepare("UPDATE follows SET state='accepted' WHERE id=?").bind(f.id)
				: c.env.DB.prepare('DELETE FROM follows WHERE id=?').bind(f.id),
			outboundStatement(
				c.env,
				a.id,
				{
					type: action === 'authorize' ? 'Accept' : 'Reject',
					actor: accountUri(c.env, a),
					object: {
						id: f.activity_uri,
						type: 'Follow',
						actor: accountUri(c.env, target),
						object: accountUri(c.env, a),
					},
				},
				[target.id]
			),
			c.env.DB.prepare(
				"UPDATE notifications SET dismissed=1 WHERE account_id=? AND from_account_id=? AND type='follow_request'"
			).bind(a.id, target.id),
		])
		return c.json(await relationship(c.env, a.id, target.id))
	})
social.post('/api/v1/accounts/:id/remove_from_followers', async (c) => {
	await authenticate(c, 'write:follows')
	const a = c.get('account'),
		target = await accountById(c.env, c.req.param('id')!),
		f = await one<FollowRow>(c.env, 'SELECT * FROM follows WHERE follower_id=? AND following_id=?', target.id, a.id)
	if (f)
		await c.env.DB.batch([
			c.env.DB.prepare('DELETE FROM follows WHERE id=?').bind(f.id),
			outboundStatement(
				c.env,
				a.id,
				{
					type: 'Reject',
					actor: accountUri(c.env, a),
					object: {
						id: f.activity_uri,
						type: 'Follow',
						actor: accountUri(c.env, target),
						object: accountUri(c.env, a),
					},
				},
				[target.id]
			),
		])
	return c.json(await relationship(c.env, a.id, target.id))
})

for (const [action, kind, remove, scope] of [
	['block', 'block', false, 'blocks'],
	['unblock', 'block', true, 'blocks'],
	['mute', 'mute', false, 'mutes'],
	['unmute', 'mute', true, 'mutes'],
	['pin', 'endorse', false, 'accounts'],
	['endorse', 'endorse', false, 'accounts'],
	['unpin', 'endorse', true, 'accounts'],
	['unendorse', 'endorse', true, 'accounts'],
	['note', 'note', false, 'accounts'],
] as const) {
	social.post('/api/v1/accounts/:id/' + action, async (c) => {
		await authenticate(c, 'write:' + scope)
		const owner = c.get('account'),
			target = await accountById(c.env, c.req.param('id')!)
		if (owner.id === target.id) throw new ApiError(422, 'Cannot apply this action to yourself')
		const input = c.req.header('content-type') ? await readInput(c.req.raw) : {},
			id = await nextId(c.env.DB),
			value =
				kind === 'note'
					? { comment: stringField(input, 'comment').slice(0, 2000) }
					: kind === 'mute'
						? { notifications: boolField(input, 'notifications', true) }
						: {}
		const duration = Number(input.duration ?? 0)
		if (!Number.isFinite(duration) || duration < 0 || duration > 31536000) throw new ApiError(422, 'Invalid duration')
		const statements = [
			remove
				? c.env.DB.prepare('DELETE FROM account_actions WHERE account_id=? AND target_id=? AND kind=?').bind(
						owner.id,
						target.id,
						kind
					)
				: c.env.DB.prepare(
						`INSERT INTO account_actions(id,account_id,target_id,kind,value,expires_at,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,target_id,kind) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`
					).bind(
						id,
						owner.id,
						target.id,
						kind,
						JSON.stringify(value),
						duration ? Date.now() + duration * 1000 : null,
						now()
					),
		]
		if (kind === 'block' && !remove) {
			statements.push(
				c.env.DB.prepare(
					'DELETE FROM follows WHERE (follower_id=? AND following_id=?) OR (follower_id=? AND following_id=?)'
				).bind(owner.id, target.id, target.id, owner.id),
				c.env.DB.prepare('UPDATE notifications SET dismissed=1 WHERE account_id=? AND from_account_id=?').bind(
					owner.id,
					target.id
				),
				outboundStatement(
					c.env,
					owner.id,
					{ type: 'Block', actor: accountUri(c.env, owner), object: accountUri(c.env, target) },
					[target.id]
				)
			)
		}
		if (kind === 'endorse')
			statements.push(
				c.env.DB.prepare(
					`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'account.event',?,?,?)`
				).bind('account:' + crypto.randomUUID(), JSON.stringify({ accountId: owner.id }), Date.now(), Date.now())
			)
		await c.env.DB.batch(statements)
		return c.json(await relationship(c.env, owner.id, target.id))
	})
}

for (const [path, kind, scope] of [
	['blocks', 'block', 'blocks'],
	['mutes', 'mute', 'mutes'],
	['endorsements', 'endorse', 'accounts'],
] as const)
	social.get('/api/v1/' + path, async (c) => {
		await authenticate(c, 'read:' + scope)
		const cur = cursors(c, 'x.id')
		const rows = await all<AccountRow & { cursor_id: string }>(
			c.env,
			`SELECT a.*,x.id cursor_id FROM account_actions x JOIN accounts a ON a.id=x.target_id WHERE x.account_id=? AND x.kind=? AND (x.expires_at IS NULL OR x.expires_at>?) ${cur.sql} ORDER BY CAST(x.id AS INTEGER) ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
			c.get('account').id,
			kind,
			Date.now(),
			...cur.binds,
			pageLimit(c)
		)
		if (cur.ascending) rows.reverse()
		links(
			c,
			rows.map((a) => ({ id: a.cursor_id }))
		)
		return c.json(await Promise.all(rows.map((a) => accountJSON(c.env, a))))
	})
social.get('/api/v1/follow_requests', async (c) => {
	await authenticate(c, 'read:follows')
	const cur = cursors(c, 'f.id')
	const rows = await all<AccountRow & { cursor_id: string }>(
		c.env,
		`SELECT a.*,f.id cursor_id FROM follows f JOIN accounts a ON a.id=f.follower_id WHERE f.following_id=? AND f.state='pending' ${cur.sql} ORDER BY CAST(f.id AS INTEGER) ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
		c.get('account').id,
		...cur.binds,
		pageLimit(c)
	)
	if (cur.ascending) rows.reverse()
	links(
		c,
		rows.map((a) => ({ id: a.cursor_id }))
	)
	return c.json(await Promise.all(rows.map((a) => accountJSON(c.env, a))))
})
for (const type of ['followers', 'following'] as const)
	social.get('/api/v1/accounts/:id/' + type, async (c) => {
		const viewer = await optionalAccount(c),
			a = await accountById(c.env, c.req.param('id')!)
		if (viewer && (await blocked(c.env, viewer, a.id))) throw new ApiError(404, 'Record not found')
		if (parsed<Record<string, unknown>>(a.preferences, {}).hide_collections && viewer !== a.id) return c.json([])
		const cur = cursors(c, 'f.id'),
			rows = await all<AccountRow & { cursor_id: string }>(
				c.env,
				`SELECT a.*,f.id cursor_id FROM follows f JOIN accounts a ON a.id=f.${type === 'followers' ? 'follower_id' : 'following_id'} WHERE f.${type === 'followers' ? 'following_id' : 'follower_id'}=? AND f.state='accepted' AND a.suspended=0 ${cur.sql} ORDER BY CAST(f.id AS INTEGER) ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
				a.id,
				...cur.binds,
				pageLimit(c)
			)
		if (cur.ascending) rows.reverse()
		links(
			c,
			rows.map((a) => ({ id: a.cursor_id }))
		)
		return c.json(await Promise.all(rows.map((a) => accountJSON(c.env, a))))
	})
social.get('/api/v1/accounts/:id/lists', async (c) => {
	await authenticate(c, 'read:lists')
	return c.json(
		(
			await all<{ id: string; title: string; replies_policy: string; exclusive: number }>(
				c.env,
				'SELECT l.* FROM lists l JOIN list_accounts m ON m.list_id=l.id WHERE l.account_id=? AND m.account_id=?',
				c.get('account').id,
				c.req.param('id')!
			)
		).map((l) => ({ id: l.id, title: l.title, replies_policy: l.replies_policy, exclusive: !!l.exclusive }))
	)
})
social.get('/api/v1/accounts/:id/identity_proofs', async (c) =>
	c.json(
		parsed<Record<string, unknown>[]>(
			parsed<Record<string, string>>((await accountById(c.env, c.req.param('id')!)).preferences, {}).identity_proofs,
			[]
		)
	)
)
social.get('/api/v1/accounts/:id/endorsements', async (c) =>
	c.json(
		await Promise.all(
			(
				await all<AccountRow>(
					c.env,
					"SELECT a.* FROM accounts a JOIN account_actions x ON x.target_id=a.id WHERE x.account_id=? AND x.kind='endorse'",
					c.req.param('id')!
				)
			).map((a) => accountJSON(c.env, a))
		)
	)
)

social.get('/api/v1/domain_blocks', async (c) => {
	await authenticate(c, 'read:blocks')
	return c.json(
		(
			await all<{ domain: string }>(
				c.env,
				'SELECT domain FROM user_domain_blocks WHERE account_id=? ORDER BY domain LIMIT 200',
				c.get('account').id
			)
		).map((d) => d.domain)
	)
})
for (const method of ['post', 'delete'] as const)
	social[method]('/api/v1/domain_blocks', async (c) => {
		await authenticate(c, 'write:blocks')
		const input = await readInput(c.req.raw)
		let domain: string
		try {
			const u = new URL('https://' + stringField(input, 'domain'))
			domain = u.hostname
			if (u.host !== stringField(input, 'domain').toLowerCase() || domain === new URL(c.env.PUBLIC_ORIGIN).hostname)
				throw 0
		} catch {
			throw new ApiError(422, 'Invalid domain')
		}
		await c.env.DB.batch([
			c.env.DB.prepare(
				method === 'post'
					? 'INSERT OR IGNORE INTO user_domain_blocks(account_id,domain) VALUES(?,?)'
					: 'DELETE FROM user_domain_blocks WHERE account_id=? AND domain=?'
			).bind(c.get('account').id, domain),
			...(method === 'post'
				? await severanceStatements(c.env, {
						type: 'user_domain_block',
						target: domain,
						localAccountId: c.get('account').id,
					})
				: []),
		])
		return c.json({})
	})
social.on(['GET', 'POST'], '/api/v1/domain_blocks/preview', async (c) => {
	await authenticate(c, 'write:blocks')
	const domain = (
		c.req.method === 'GET' ? (c.req.query('domain') ?? '') : stringField(await readInput(c.req.raw), 'domain')
	)
		.trim()
		.toLowerCase()
	if (!/^[a-z0-9.-]+$/.test(domain)) throw new ApiError(422, 'Invalid domain')
	const count = await one<{ following_count: number; followers_count: number }>(
		c.env,
		"SELECT (SELECT COUNT(*) FROM follows f JOIN accounts a ON a.id=f.following_id WHERE f.follower_id=? AND a.domain=? AND f.state='accepted') following_count,(SELECT COUNT(*) FROM follows f JOIN accounts a ON a.id=f.follower_id WHERE f.following_id=? AND a.domain=? AND f.state='accepted') followers_count",
		c.get('account').id,
		domain,
		c.get('account').id,
		domain
	)
	return c.json(count)
})
