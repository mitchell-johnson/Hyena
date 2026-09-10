import { cidr, canonicalEmail } from './moderation-policy'
import { deleteAccount } from './lifecycle'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { authenticate } from './auth/access'
import { digest } from './auth/crypto'
import {
	all,
	one,
	run,
	parsed,
	now,
	accountById,
	accountUri,
	statusUri,
	list,
	cursors,
	pageLimit,
	links,
	type Bind,
} from './data'
import { nextId } from './db'
import { ApiError, boolField, readInput, stringField } from './http'
import { accountJSON, statusJSON } from './serializers'
import { requireStatus } from './status-actions'
import { outboundStatement } from './federation/outbox'
import { notificationStatements } from './notifications'
import { severanceStatements } from './severance'
import type { AccountRow, AppEnv, Env, StatusRow } from './types'
export const admin = new Hono<AppEnv>()
export async function requireAdmin(c: Context<AppEnv>, scope: string, ownerOnly = false) {
	await authenticate(c, scope)
	const a = c.get('account')
	if (a.role !== 'admin' && (ownerOnly || a.role !== 'moderator'))
		throw new ApiError(403, 'Administrator permission required')
	return a
}
export function auditStatement(env: Env, actor: string, action: string, target: string | null, data: unknown = {}) {
	return env.DB.prepare(
		'INSERT INTO audit_log(id,account_id,action,target_id,data,created_at) VALUES(?,?,?,?,?,?)'
	).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(data), now())
}
export async function adminAccount(env: Env, a: AccountRow) {
	return {
		id: a.id,
		username: a.username,
		domain: a.domain || null,
		created_at: a.created_at,
		email: a.email ?? '',
		ip: null,
		ips: [],
		locale: parsed<Record<string, unknown>>(a.preferences, {}).locale ?? 'en',
		invite_request: parsed<Record<string, unknown>>(a.preferences, {}).reason ?? null,
		role: {
			id: a.role === 'admin' ? '1' : '0',
			name: a.role ?? 'user',
			color: '',
			position: a.role === 'admin' ? 100 : 0,
			permissions: a.role === 'admin' ? '1' : '0',
			highlighted: false,
		},
		confirmed: !a.email || !!a.email_confirmed,
		approved: !!a.approved,
		disabled: !!a.disabled,
		silenced: !!a.silenced,
		suspended: !!a.suspended,
		sensitized: !!a.sensitive,
		account: await accountJSON(env, a),
		invited_by_account_id: null,
	}
}
for (const version of [1, 2])
	admin.get(`/api/v${version}/admin/accounts`, async (c) => {
		await requireAdmin(c, 'admin:read:accounts')
		const clauses = ['1=1'],
			binds: Bind[] = [],
			params = new URL(c.req.url).searchParams
		for (const key of ['username', 'email', 'domain'] as const) {
			const value = params.get(key)
			if (value) {
				clauses.push(`${key}=?`)
				binds.push(value)
			}
		}
		for (const key of ['suspended', 'silenced', 'disabled'] as const)
			if (params.get(key) === 'true') clauses.push(key + '=1')
		if (params.get('local') === 'true' || params.get('origin') === 'local') clauses.push("domain=''")
		if (params.get('remote') === 'true' || params.get('origin') === 'remote') clauses.push("domain<>''")
		if (params.get('pending') === 'true' || params.get('status') === 'pending') clauses.push('approved=0')
		const cur = cursors(c),
			rows = await all<AccountRow>(
				c.env,
				`SELECT * FROM accounts WHERE ${clauses.join(' AND ')} ${cur.sql} ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`,
				...binds,
				...cur.binds,
				pageLimit(c, 200, 100)
			)
		links(c, rows)
		return c.json(await Promise.all(rows.map((a) => adminAccount(c.env, a))))
	})
admin.get('/api/v1/admin/accounts/:id', async (c) => {
	await requireAdmin(c, 'admin:read:accounts')
	return c.json(await adminAccount(c.env, await accountById(c.env, c.req.param('id'))))
})
for (const [action, field, value] of [
	['enable', 'disabled', 0],
	['unsensitive', 'sensitive', 0],
	['unsilence', 'silenced', 0],
	['unsuspend', 'suspended', 0],
	['approve', 'approved', 1],
	['reject', 'approved', 0],
] as const)
	admin.post('/api/v1/admin/accounts/:id/' + action, async (c) => {
		const a = await requireAdmin(c, 'admin:write:accounts'),
			target = await accountById(c.env, c.req.param('id')!)
		if (target.role === 'admin' && a.id !== target.id) throw new ApiError(403, 'Cannot moderate an administrator')
		await c.env.DB.batch([
			c.env.DB.prepare(`UPDATE accounts SET ${field}=? WHERE id=?`).bind(value, target.id),
			auditStatement(c.env, a.id, 'account.' + action, target.id),
		])
		return c.json(await adminAccount(c.env, await accountById(c.env, target.id)))
	})
admin.post('/api/v1/admin/accounts/:id/action', async (c) => {
	const a = await requireAdmin(c, 'admin:write:accounts'),
		target = await accountById(c.env, c.req.param('id')),
		input = await readInput(c.req.raw),
		type = stringField(input, 'type')
	if (target.role === 'admin' || target.id === a.id) throw new ApiError(403, 'Cannot moderate the owner')
	const field = { disable: 'disabled', silence: 'silenced', suspend: 'suspended', sensitive: 'sensitive', none: null }[
		type
	]
	if (field === undefined) throw new ApiError(422, 'Invalid account action')
	const warningId = await nextId(c.env.DB),
		warningText = stringField(input, 'text').slice(0, 4000)
	const statements = [
		auditStatement(c.env, a.id, 'account.' + type, target.id, {
			text: stringField(input, 'text').slice(0, 4000),
			report_id: input.report_id ?? null,
		}),
	]
	if (field) statements.push(c.env.DB.prepare(`UPDATE accounts SET ${field}=1 WHERE id=?`).bind(target.id))
	if (type === 'suspend')
		statements.push(
			...(await severanceStatements(c.env, {
				type: 'account_suspension',
				target: target.username + (target.domain ? '@' + target.domain : ''),
				targetAccountId: target.id,
			}))
		)
	statements.push(
		...(await notificationStatements(c.env, target.id, a.id, 'moderation_warning', null, 'warning:' + warningId))
	)
	statements.push(
		c.env.DB.prepare('UPDATE notifications SET details=? WHERE event_key=?').bind(
			JSON.stringify({
				moderation_warning: {
					id: warningId,
					action: type,
					text: warningText,
					status_ids: [],
					created_at: now(),
					target_account: await accountJSON(c.env, target),
					appeal: null,
				},
			}),
			'warning:' + warningId
		)
	)
	if (boolField(input, 'send_email') && target.email && c.env.EMAIL)
		statements.push(
			c.env.DB.prepare("INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'email.send',?,?,?)").bind(
				'warning-mail:' + warningId,
				JSON.stringify({
					to: target.email,
					subject: 'Moderation notice from ' + c.env.INSTANCE_TITLE,
					text: warningText + '\nAction: ' + type,
				}),
				Date.now(),
				Date.now()
			)
		)

	if (['disable', 'suspend'].includes(type))
		statements.push(
			c.env.DB.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').bind(
				Date.now(),
				target.id
			),
			c.env.DB.prepare('DELETE FROM sessions WHERE account_id=?').bind(target.id)
		)
	await c.env.DB.batch(statements)
	if (['disable', 'suspend'].includes(type)) await c.env.STREAMS.get(c.env.STREAMS.idFromName(target.id)).revokeAll()
	return c.json({})
})
admin.delete('/api/v1/admin/accounts/:id', async (c) => {
	const a = await requireAdmin(c, 'admin:write:accounts', true),
		target = await accountById(c.env, c.req.param('id'))
	if (target.role === 'admin') throw new ApiError(403, 'Cannot delete the instance owner')
	await deleteAccount(c.env, target)
	await auditStatement(c.env, a.id, 'account.delete', target.id).run()
	return c.json({})
})

export interface Report {
	id: string
	account_id: string
	target_account_id: string
	comment: string
	category: string
	status_ids: string
	rule_ids: string
	forwarded: number
	action_taken: number
	assigned_account_id: string | null
	action_taken_by_account_id: string | null
	created_at: string
	updated_at: string
}
export async function reportJSON(env: Env, r: Report, full = false) {
	const base = {
		id: r.id,
		action_taken: !!r.action_taken,
		action_taken_at: r.action_taken ? r.updated_at : null,
		category: r.category,
		comment: r.comment,
		forwarded: !!r.forwarded,
		created_at: r.created_at,
		status_ids: parsed<string[]>(r.status_ids, []),
		rule_ids: parsed<string[]>(r.rule_ids, []),
		target_account: await accountJSON(env, await accountById(env, r.target_account_id)),
	}
	if (!full) return base
	return {
		...base,
		updated_at: r.updated_at,
		account: await adminAccount(env, await accountById(env, r.account_id)),
		target_account: await adminAccount(env, await accountById(env, r.target_account_id)),
		assigned_account: r.assigned_account_id
			? await adminAccount(env, await accountById(env, r.assigned_account_id))
			: null,
		action_taken_by_account: r.action_taken_by_account_id
			? await adminAccount(env, await accountById(env, r.action_taken_by_account_id))
			: null,
		statuses: await Promise.all(
			base.status_ids.map(async (id) => {
				const s = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', id)
				return s ? statusJSON(env, s, r.account_id) : null
			})
		),
		rules: await all(
			env,
			`SELECT id,text,hint FROM instance_rules WHERE id IN (${base.rule_ids.map(() => '?').join(',') || 'NULL'})`,
			...base.rule_ids
		),
	}
}
admin.post('/api/v1/reports', async (c) => {
	await authenticate(c, 'write:reports')
	const a = c.get('account'),
		input = await readInput(c.req.raw),
		target = await accountById(c.env, stringField(input, 'account_id')),
		comment = stringField(input, 'comment'),
		ids = list(input.status_ids, 100),
		rules = list(input.rule_ids, 100),
		category = stringField(input, 'category', rules.length ? 'violation' : 'other'),
		forwarded = boolField(input, 'forward')
	if (comment.length > 1000 || !['other', 'spam', 'violation', 'legal'].includes(category) || a.id === target.id)
		throw new ApiError(422, 'Invalid report')
	for (const id of ids) {
		const s = await requireStatus(c.env, id, a.id)
		if (s.account_id !== target.id) throw new ApiError(422, 'Reported statuses must belong to the target account')
	}
	const id = await nextId(c.env.DB),
		statements = [
			c.env.DB.prepare(
				'INSERT INTO reports(id,account_id,target_account_id,comment,category,status_ids,rule_ids,forwarded,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
			).bind(
				id,
				a.id,
				target.id,
				comment,
				category,
				JSON.stringify(ids),
				JSON.stringify(rules),
				+forwarded,
				now(),
				now()
			),
		]
	for (const m of await all<AccountRow>(
		c.env,
		"SELECT * FROM accounts WHERE role IN ('admin','moderator') AND domain=''"
	))
		statements.push(
			...(await notificationStatements(c.env, m.id, a.id, 'admin.report', null, 'report:' + id + ':' + m.id)),
			c.env.DB.prepare('UPDATE notifications SET details=? WHERE event_key=?').bind(
				JSON.stringify({ report_id: id }),
				'report:' + id + ':' + m.id
			)
		)
	if (forwarded && target.domain) {
		const objects = [accountUri(c.env, target)]
		for (const sid of ids)
			objects.push(statusUri(c.env, (await one<StatusRow>(c.env, 'SELECT * FROM statuses WHERE id=?', sid))!, target))
		statements.push(
			outboundStatement(c.env, a.id, { type: 'Flag', actor: accountUri(c.env, a), object: objects, summary: comment }, [
				target.id,
			])
		)
	}
	await c.env.DB.batch(statements)
	return c.json(await reportJSON(c.env, (await one<Report>(c.env, 'SELECT * FROM reports WHERE id=?', id))!))
})
admin.get('/api/v1/admin/reports', async (c) => {
	await requireAdmin(c, 'admin:read:reports')
	const cur = cursors(c),
		resolved = c.req.query('resolved')
	const rows = await all<Report>(
		c.env,
		`SELECT * FROM reports WHERE 1=1 ${resolved === undefined ? '' : 'AND action_taken=?'} ${cur.sql} ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`,
		...(resolved === undefined ? [] : [resolved === 'true' ? 1 : 0]),
		...cur.binds,
		pageLimit(c, 100)
	)
	links(c, rows)
	return c.json(await Promise.all(rows.map((r) => reportJSON(c.env, r, true))))
})
admin.get('/api/v1/admin/reports/:id', async (c) => {
	await requireAdmin(c, 'admin:read:reports')
	const r = await one<Report>(c.env, 'SELECT * FROM reports WHERE id=?', c.req.param('id'))
	if (!r) throw new ApiError(404, 'Record not found')
	return c.json(await reportJSON(c.env, r, true))
})
admin.put('/api/v1/admin/reports/:id', async (c) => {
	const a = await requireAdmin(c, 'admin:write:reports'),
		r = await one<Report>(c.env, 'SELECT * FROM reports WHERE id=?', c.req.param('id'))
	if (!r) throw new ApiError(404, 'Record not found')
	const input = await readInput(c.req.raw),
		category = stringField(input, 'category', r.category)
	if (!['other', 'spam', 'violation', 'legal'].includes(category)) throw new ApiError(422, 'Invalid category')
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE reports SET category=?,rule_ids=?,updated_at=? WHERE id=?').bind(
			category,
			JSON.stringify(input.rule_ids === undefined ? JSON.parse(r.rule_ids) : list(input.rule_ids)),
			now(),
			r.id
		),
		auditStatement(c.env, a.id, 'report.update', r.id),
	])
	return c.json(await reportJSON(c.env, (await one<Report>(c.env, 'SELECT * FROM reports WHERE id=?', r.id))!, true))
})
for (const action of ['assign_to_self', 'unassign', 'reopen', 'resolve'])
	admin.post('/api/v1/admin/reports/:id/' + action, async (c) => {
		const a = await requireAdmin(c, 'admin:write:reports'),
			id = c.req.param('id')!
		if (!(await one(c.env, 'SELECT 1 FROM reports WHERE id=?', id))) throw new ApiError(404, 'Record not found')
		const field = action === 'assign_to_self' || action === 'unassign' ? 'assigned_account_id' : 'action_taken',
			value = action === 'assign_to_self' ? a.id : action === 'unassign' ? null : action === 'resolve' ? 1 : 0
		await c.env.DB.batch([
			c.env.DB.prepare(
				`UPDATE reports SET ${field}=?,updated_at=?${action === 'resolve' ? ',action_taken_by_account_id=?' : ''} WHERE id=?`
			).bind(value, now(), ...(action === 'resolve' ? [a.id] : []), id),
			auditStatement(c.env, a.id, 'report.' + action, id),
		])
		return c.json(await reportJSON(c.env, (await one<Report>(c.env, 'SELECT * FROM reports WHERE id=?', id))!, true))
	})

type RuleRow = { id: string; kind: string; value: string; data: string; created_at: string }
function ruleJSON(r: RuleRow) {
	const data = parsed<Record<string, unknown>>(r.data, {})
	return {
		id: r.id,
		created_at: r.created_at,
		...(r.kind === 'ip_blocks'
			? { ip: r.value }
			: r.kind === 'canonical_email_blocks'
				? { canonical_email_hash: r.value }
				: { domain: r.value }),
		...data,
	}
}
for (const kind of ['domain_allows', 'domain_blocks', 'email_domain_blocks', 'ip_blocks', 'canonical_email_blocks']) {
	const path = '/api/v1/admin/' + kind
	admin.get(path, async (c) => {
		await requireAdmin(c, 'admin:read:' + kind, true)
		const cur = cursors(c),
			rows = await all<RuleRow>(
				c.env,
				`SELECT * FROM moderation_rules WHERE kind=? ${cur.sql} ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`,
				kind,
				...cur.binds,
				pageLimit(c, 200)
			)
		links(c, rows)
		return c.json(rows.map(ruleJSON))
	})
	admin.get(path + '/:id', async (c) => {
		await requireAdmin(c, 'admin:read:' + kind, true)
		const r = await one<RuleRow>(
			c.env,
			'SELECT * FROM moderation_rules WHERE kind=? AND id=?',
			kind,
			c.req.param('id')!
		)
		if (!r) throw new ApiError(404, 'Record not found')
		return c.json(ruleJSON(r))
	})
	for (const method of ['post', 'put'] as const)
		admin[method](method === 'post' ? path : path + '/:id', async (c) => {
			const a = await requireAdmin(c, 'admin:write:' + kind, true),
				input = await readInput(c.req.raw),
				old =
					method === 'put'
						? await one<RuleRow>(
								c.env,
								'SELECT * FROM moderation_rules WHERE id=? AND kind=?',
								c.req.param('id')!,
								kind
							)
						: null
			if (method === 'put' && !old) throw new ApiError(404, 'Record not found')
			let value = stringField(
				input,
				kind === 'ip_blocks' ? 'ip' : kind === 'canonical_email_blocks' ? 'email' : 'domain',
				old?.value ?? ''
			).toLowerCase()
			if (!value || value.length > 255) throw new ApiError(422, 'Invalid rule value')
			if (kind.includes('domain') && !/^[a-z0-9.-]+$/.test(value)) throw new ApiError(422, 'Invalid domain')
			if (kind === 'canonical_email_blocks')
				value = input.email === undefined && old ? old.value : await canonicalEmail(value)
			const data = { ...parsed<Record<string, unknown>>(old?.data, {}), ...input }
			delete data.domain
			delete data.ip
			delete data.email
			delete data.id
			if (kind === 'domain_blocks') {
				data.severity = String(data.severity ?? 'suspend')
				if (!['silence', 'suspend', 'noop'].includes(String(data.severity))) throw new ApiError(422, 'Invalid severity')
				for (const key of ['reject_media', 'reject_reports', 'obfuscate']) data[key] = boolField(data, key, false)
			}
			if (
				kind === 'ip_blocks' &&
				!['sign_up_requires_approval', 'sign_up_block', 'no_access'].includes(String(data.severity))
			)
				throw new ApiError(422, 'Invalid IP block severity')
			if (kind === 'ip_blocks') {
				cidr(value)
				if (input.expires_in !== undefined) {
					const seconds = Number(input.expires_in)
					if (!Number.isFinite(seconds) || seconds < 60 || seconds > 315360000)
						throw new ApiError(422, 'Invalid IP rule expiry')
					data.expires_at = new Date(Date.now() + seconds * 1000).toISOString()
					delete data.expires_in
				}
			}
			const id = old?.id ?? (await nextId(c.env.DB))
			await c.env.DB.batch([
				c.env.DB.prepare(
					'INSERT INTO moderation_rules(id,kind,value,data,created_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,value) DO UPDATE SET data=excluded.data'
				).bind(id, kind, value, JSON.stringify(data), old?.created_at ?? now()),
				auditStatement(c.env, a.id, kind + '.' + method, id),
				...(kind === 'domain_blocks' && data.severity === 'suspend'
					? await severanceStatements(c.env, { type: 'domain_block', target: value })
					: []),
			])
			return c.json(
				ruleJSON((await one<RuleRow>(c.env, 'SELECT * FROM moderation_rules WHERE kind=? AND value=?', kind, value))!)
			)
		})
	admin.delete(path + '/:id', async (c) => {
		const a = await requireAdmin(c, 'admin:write:' + kind, true)
		const result = await c.env.DB.batch([
			c.env.DB.prepare('DELETE FROM moderation_rules WHERE kind=? AND id=?').bind(kind, c.req.param('id')!),
			auditStatement(c.env, a.id, kind + '.delete', c.req.param('id')!),
		])
		if (!result[0]?.meta.changes) throw new ApiError(404, 'Record not found')
		return c.json({})
	})
}
admin.post('/api/v1/admin/canonical_email_blocks/test', async (c) => {
	await requireAdmin(c, 'admin:read:canonical_email_blocks', true)
	const input = await readInput(c.req.raw),
		value = await canonicalEmail(stringField(input, 'email'))
	return c.json(
		(
			await all<RuleRow>(c.env, "SELECT * FROM moderation_rules WHERE kind='canonical_email_blocks' AND value=?", value)
		).map(ruleJSON)
	)
})
