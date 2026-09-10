import { trendHistory } from './trend-history'
import { Hono } from 'hono'
import { authenticate, optionalAccount } from './auth/access'
import { nextId } from './db'
import { all, one, run, now, parsed, list, object, accountById } from './data'
import { ApiError, boolField, readInput, stringField } from './http'
import { accountJSON, filterJSON } from './serializers'
import type { AppEnv, Env, AccountRow } from './types'

export const organize = new Hono<AppEnv>()
type ListRow = { id: string; account_id: string; title: string; replies_policy: string; exclusive: number }
const listJSON = (l: ListRow) => ({
	id: l.id,
	title: l.title,
	replies_policy: l.replies_policy,
	exclusive: !!l.exclusive,
})
async function owned(env: Env, table: 'lists' | 'filters', id: string, owner: string) {
	const row = await one<{ id: string }>(env, `SELECT id FROM ${table} WHERE id=? AND account_id=?`, id, owner)
	if (!row) throw new ApiError(404, 'Record not found')
	return row
}
organize.get('/api/v1/lists', async (c) => {
	await authenticate(c, 'read:lists')
	return c.json(
		(await all<ListRow>(c.env, 'SELECT * FROM lists WHERE account_id=? ORDER BY title', c.get('account').id)).map(
			listJSON
		)
	)
})
organize.get('/api/v1/lists/:id', async (c) => {
	await authenticate(c, 'read:lists')
	await owned(c.env, 'lists', c.req.param('id'), c.get('account').id)
	return c.json(listJSON((await one<ListRow>(c.env, 'SELECT * FROM lists WHERE id=?', c.req.param('id')))!))
})
for (const method of ['post', 'put'] as const)
	organize[method](method === 'post' ? '/api/v1/lists' : '/api/v1/lists/:id', async (c) => {
		await authenticate(c, 'write:lists')
		const input = await readInput(c.req.raw),
			id = method === 'post' ? await nextId(c.env.DB) : c.req.param('id')!
		if (method === 'put') await owned(c.env, 'lists', id, c.get('account').id)
		const old = await one<ListRow>(c.env, 'SELECT * FROM lists WHERE id=?', id),
			title = stringField(input, 'title', old?.title ?? ''),
			policy = stringField(input, 'replies_policy', old?.replies_policy ?? 'list'),
			exclusive = boolField(input, 'exclusive', !!old?.exclusive)
		if (!title.trim() || title.length > 64 || !['followed', 'list', 'none'].includes(policy))
			throw new ApiError(422, 'Invalid list settings')
		await run(
			c.env,
			'INSERT INTO lists(id,account_id,title,replies_policy,exclusive) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,replies_policy=excluded.replies_policy,exclusive=excluded.exclusive',
			id,
			c.get('account').id,
			title,
			policy,
			+exclusive
		)
		return c.json(
			listJSON({ id, account_id: c.get('account').id, title, replies_policy: policy, exclusive: +exclusive })
		)
	})
organize.delete('/api/v1/lists/:id', async (c) => {
	await authenticate(c, 'write:lists')
	await owned(c.env, 'lists', c.req.param('id'), c.get('account').id)
	await run(c.env, 'DELETE FROM lists WHERE id=?', c.req.param('id'))
	return c.json({})
})
organize.get('/api/v1/lists/:id/accounts', async (c) => {
	await authenticate(c, 'read:lists')
	await owned(c.env, 'lists', c.req.param('id'), c.get('account').id)
	return c.json(
		await Promise.all(
			(
				await all<AccountRow>(
					c.env,
					'SELECT a.* FROM accounts a JOIN list_accounts m ON m.account_id=a.id WHERE m.list_id=? ORDER BY a.username',
					c.req.param('id')
				)
			).map((a) => accountJSON(c.env, a))
		)
	)
})
for (const method of ['post', 'delete'] as const)
	organize[method]('/api/v1/lists/:id/accounts', async (c) => {
		await authenticate(c, 'write:lists')
		const owner = c.get('account').id,
			id = c.req.param('id')
		await owned(c.env, 'lists', id, owner)
		const ids = list((await readInput(c.req.raw)).account_ids)
		if (method === 'post')
			for (const a of ids)
				if (
					!(await one(
						c.env,
						"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
						owner,
						a
					))
				)
					throw new ApiError(422, 'List members must be followed accounts')
		if (ids.length)
			await c.env.DB.batch(
				ids.map((a) =>
					method === 'post'
						? c.env.DB.prepare(
								"INSERT OR IGNORE INTO list_accounts(list_id,account_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted')"
							).bind(id, a, owner, a)
						: c.env.DB.prepare('DELETE FROM list_accounts WHERE list_id=? AND account_id=?').bind(id, a)
				)
			)
		return c.json({})
	})

export function attributes(value: unknown): Record<string, unknown>[] {
	if (value === undefined) return []
	const rows = Array.isArray(value) ? value : Object.values(object(value))
	if (rows.length > 100) throw new ApiError(422, 'Too many attributes')
	return rows.map(object)
}
export function expiry(input: Record<string, unknown>, fallback: string | null = null): string | null {
	if (input.expires_in === undefined) return fallback
	if (input.expires_in === null || input.expires_in === '') return null
	const n = Number(input.expires_in)
	if (!Number.isFinite(n) || n <= 0 || n > 31536000) throw new ApiError(422, 'Invalid expiry')
	return new Date(Date.now() + n * 1000).toISOString()
}
async function writeFilter(env: Env, owner: string, input: Record<string, unknown>, id: string, version: number) {
	const old = await filterJSON(env, id),
		title = stringField(input, version === 1 ? 'phrase' : 'title', old?.title ?? ''),
		context = input.context === undefined ? (old?.context ?? []) : list(input.context, 5),
		action =
			version === 1
				? boolField(input, 'irreversible', old?.filter_action === 'hide')
					? 'hide'
					: 'warn'
				: stringField(input, 'filter_action', old?.filter_action ?? 'warn')
	if (
		!title.trim() ||
		title.length > 200 ||
		!context.length ||
		context.some((x) => !['home', 'notifications', 'public', 'thread', 'account'].includes(x)) ||
		!['warn', 'hide'].includes(action)
	)
		throw new ApiError(422, 'Invalid filter')
	const statements = [
		env.DB.prepare(
			'INSERT INTO filters(id,account_id,title,context,filter_action,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,context=excluded.context,filter_action=excluded.filter_action,expires_at=excluded.expires_at'
		).bind(id, owner, title, JSON.stringify(context), action, expiry(input, old?.expires_at)),
	]
	const keywords =
		version === 1
			? [
					{
						id: old?.keywords[0]?.id,
						keyword: title,
						whole_word: boolField(input, 'whole_word', old?.keywords[0]?.whole_word ?? false),
					},
				]
			: attributes(input.keywords_attributes)
	for (const k of keywords) {
		const kid = typeof k.id === 'string' ? k.id : await nextId(env.DB)
		if (k.id && !old?.keywords.some((x) => x.id === kid)) throw new ApiError(404, 'Keyword not found')
		if (boolField(k, '_destroy')) {
			statements.push(env.DB.prepare('DELETE FROM filter_keywords WHERE id=? AND filter_id=?').bind(kid, id))
			continue
		}
		const keyword = stringField(k, 'keyword', old?.keywords.find((x) => x.id === kid)?.keyword ?? '')
		if (!keyword.trim() || keyword.length > 200) throw new ApiError(422, 'Invalid keyword')
		statements.push(
			env.DB.prepare(
				'INSERT INTO filter_keywords(id,filter_id,keyword,whole_word) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET keyword=excluded.keyword,whole_word=excluded.whole_word'
			).bind(
				kid,
				id,
				keyword,
				+boolField(k, 'whole_word', old?.keywords.find((x) => x.id === kid)?.whole_word ?? false)
			)
		)
	}
	await env.DB.batch(statements)
	return (await filterJSON(env, id))!
}
const legacy = (f: NonNullable<Awaited<ReturnType<typeof filterJSON>>>) => ({
	id: f.id,
	phrase: f.keywords[0]?.keyword ?? f.title,
	context: f.context,
	whole_word: f.keywords[0]?.whole_word ?? false,
	expires_at: f.expires_at,
	irreversible: f.filter_action === 'hide',
})
for (const version of [1, 2]) {
	organize.get(`/api/v${version}/filters`, async (c) => {
		await authenticate(c, 'read:filters')
		const rows = await all<{ id: string }>(c.env, 'SELECT id FROM filters WHERE account_id=?', c.get('account').id),
			data = await Promise.all(rows.map(async (r) => (await filterJSON(c.env, r.id))!))
		return c.json(version === 1 ? data.map(legacy) : data)
	})
	organize.get(`/api/v${version}/filters/:id`, async (c) => {
		await authenticate(c, 'read:filters')
		await owned(c.env, 'filters', c.req.param('id')!, c.get('account').id)
		const f = (await filterJSON(c.env, c.req.param('id')!))!
		return c.json(version === 1 ? legacy(f) : f)
	})
	for (const method of ['post', 'put'] as const)
		organize[method](method === 'post' ? `/api/v${version}/filters` : `/api/v${version}/filters/:id`, async (c) => {
			await authenticate(c, 'write:filters')
			const id = method === 'post' ? await nextId(c.env.DB) : c.req.param('id')!
			if (method === 'put') await owned(c.env, 'filters', id, c.get('account').id)
			const f = await writeFilter(c.env, c.get('account').id, await readInput(c.req.raw), id, version)
			return c.json(version === 1 ? legacy(f) : f)
		})
	organize.delete(`/api/v${version}/filters/:id`, async (c) => {
		await authenticate(c, 'write:filters')
		await owned(c.env, 'filters', c.req.param('id')!, c.get('account').id)
		await run(c.env, 'DELETE FROM filters WHERE id=?', c.req.param('id')!)
		return c.json({})
	})
}
for (const kind of ['keywords', 'statuses'] as const) {
	organize.get(`/api/v2/filters/:id/${kind}`, async (c) => {
		await authenticate(c, 'read:filters')
		await owned(c.env, 'filters', c.req.param('id')!, c.get('account').id)
		return c.json((await filterJSON(c.env, c.req.param('id')!))![kind])
	})
	organize.post(`/api/v2/filters/:id/${kind}`, async (c) => {
		await authenticate(c, 'write:filters')
		const id = c.req.param('id')!,
			owner = c.get('account').id
		await owned(c.env, 'filters', id, owner)
		const input = await readInput(c.req.raw),
			child = await nextId(c.env.DB)
		if (kind === 'keywords') {
			await writeFilter(c.env, owner, { keywords_attributes: [{ ...input, id: undefined }] }, id, 2)
			return c.json((await filterJSON(c.env, id))!.keywords.at(-1))
		}
		const status = stringField(input, 'status_id')
		await run(c.env, 'INSERT INTO filter_statuses(id,filter_id,status_id) VALUES(?,?,?)', child, id, status)
		return c.json({ id: child, status_id: status })
	})
	organize.get(`/api/v2/filters/${kind}/:id`, async (c) => {
		await authenticate(c, 'read:filters')
		const r = await one<{ id: string; filter_id: string }>(
			c.env,
			`SELECT k.* FROM filter_${kind} k JOIN filters f ON f.id=k.filter_id WHERE k.id=? AND f.account_id=?`,
			c.req.param('id')!,
			c.get('account').id
		)
		if (!r) throw new ApiError(404, 'Record not found')
		const f = (await filterJSON(c.env, r.filter_id))!
		return c.json(f[kind].find((x) => x.id === r.id))
	})
	organize.delete(`/api/v2/filters/${kind}/:id`, async (c) => {
		await authenticate(c, 'write:filters')
		const result = await run(
			c.env,
			`DELETE FROM filter_${kind} WHERE id=? AND filter_id IN (SELECT id FROM filters WHERE account_id=?)`,
			c.req.param('id')!,
			c.get('account').id
		)
		if (!result.meta.changes) throw new ApiError(404, 'Record not found')
		return c.json({})
	})
}
organize.put('/api/v2/filters/keywords/:id', async (c) => {
	await authenticate(c, 'write:filters')
	const k = await one<{ filter_id: string }>(
		c.env,
		'SELECT k.filter_id FROM filter_keywords k JOIN filters f ON f.id=k.filter_id WHERE k.id=? AND f.account_id=?',
		c.req.param('id'),
		c.get('account').id
	)
	if (!k) throw new ApiError(404, 'Record not found')
	const f = await writeFilter(
		c.env,
		c.get('account').id,
		{ keywords_attributes: [{ ...(await readInput(c.req.raw)), id: c.req.param('id') }] },
		k.filter_id,
		2
	)
	return c.json(f.keywords.find((k) => k.id === c.req.param('id')))
})

export async function tagJSON(env: Env, name: string, viewer: string | null = null) {
	const tag = await one<{ name: string; display_name: string }>(env, 'SELECT * FROM tags WHERE name=?', name)
	if (!tag) throw new ApiError(404, 'Record not found')
	const history = await trendHistory(
		env,
		viewer,
		'EXISTS(SELECT 1 FROM status_tags t WHERE t.status_id=s.id AND t.tag=?)',
		[tag.name]
	)
	return {
		id: tag.name,
		name: tag.display_name,
		url: `${env.PUBLIC_ORIGIN}/tags/${encodeURIComponent(tag.name)}`,
		history,
		following: viewer
			? !!(await one(
					env,
					"SELECT 1 FROM account_tags WHERE account_id=? AND tag=? AND kind='follow'",
					viewer,
					tag.name
				))
			: false,
		featuring: viewer
			? !!(await one(
					env,
					"SELECT 1 FROM account_tags WHERE account_id=? AND tag=? AND kind='feature'",
					viewer,
					tag.name
				))
			: false,
	}
}
async function ensureTag(env: Env, name: string) {
	const normalized = name.replace(/^#/, '').normalize('NFKC').toLocaleLowerCase()
	if (!/^[\p{L}\p{N}_]{1,100}$/u.test(normalized)) throw new ApiError(422, 'Invalid hashtag')
	await run(
		env,
		'INSERT OR IGNORE INTO tags(name,display_name,created_at) VALUES(?,?,?)',
		normalized,
		name.replace(/^#/, ''),
		now()
	)
	return normalized
}
organize.get('/api/v1/tags/:id', async (c) => c.json(await tagJSON(c.env, c.req.param('id'), await optionalAccount(c))))
for (const action of ['follow', 'unfollow', 'feature', 'unfeature'] as const)
	organize.post('/api/v1/tags/:id/' + action, async (c) => {
		await authenticate(c, 'write:follows')
		const tag = await ensureTag(c.env, c.req.param('id')!),
			kind = action.includes('feature') ? 'feature' : 'follow',
			owner = c.get('account').id
		if (action.startsWith('un'))
			await run(c.env, 'DELETE FROM account_tags WHERE account_id=? AND tag=? AND kind=?', owner, tag, kind)
		else
			await run(
				c.env,
				'INSERT OR IGNORE INTO account_tags(id,account_id,tag,kind) VALUES(?,?,?,?)',
				await nextId(c.env.DB),
				owner,
				tag,
				kind
			)
		return c.json(await tagJSON(c.env, tag, owner))
	})
organize.get('/api/v1/followed_tags', async (c) => {
	await authenticate(c, 'read:follows')
	return c.json(
		await Promise.all(
			(
				await all<{ tag: string }>(
					c.env,
					"SELECT tag FROM account_tags WHERE account_id=? AND kind='follow'",
					c.get('account').id
				)
			).map((t) => tagJSON(c.env, t.tag, c.get('account').id))
		)
	)
})
async function featured(env: Env, owner: string) {
	const rows = await all<{ id: string; tag: string }>(
		env,
		"SELECT id,tag FROM account_tags WHERE account_id=? AND kind='feature'",
		owner
	)
	return Promise.all(
		rows.map(async (t) => {
			const stat = await one<{ n: number; latest: string | null }>(
				env,
				"SELECT COUNT(*) n,MAX(s.created_at) latest FROM status_tags t JOIN statuses s ON s.id=t.status_id WHERE t.tag=? AND s.account_id=? AND s.deleted_at IS NULL AND s.visibility IN ('public','unlisted')",
				t.tag,
				owner
			)
			return {
				id: t.id,
				name: t.tag,
				url: `${env.PUBLIC_ORIGIN}/tags/${encodeURIComponent(t.tag)}`,
				statuses_count: String(stat?.n ?? 0),
				last_status_at: stat?.latest ?? null,
			}
		})
	)
}
organize.get('/api/v1/featured_tags', async (c) => {
	await authenticate(c, 'read:accounts')
	return c.json(await featured(c.env, c.get('account').id))
})
organize.get('/api/v1/accounts/:id/featured_tags', async (c) => {
	await accountById(c.env, c.req.param('id'))
	return c.json(await featured(c.env, c.req.param('id')))
})
organize.post('/api/v1/featured_tags', async (c) => {
	await authenticate(c, 'write:accounts')
	const tag = await ensureTag(c.env, stringField(await readInput(c.req.raw), 'name'))
	await run(
		c.env,
		"INSERT OR IGNORE INTO account_tags(id,account_id,tag,kind) VALUES(?,?,?,'feature')",
		await nextId(c.env.DB),
		c.get('account').id,
		tag
	)
	return c.json((await featured(c.env, c.get('account').id)).find((t) => t.name === tag))
})
organize.delete('/api/v1/featured_tags/:id', async (c) => {
	await authenticate(c, 'write:accounts')
	await run(
		c.env,
		"DELETE FROM account_tags WHERE id=? AND account_id=? AND kind='feature'",
		c.req.param('id'),
		c.get('account').id
	)
	return c.json({})
})
organize.get('/api/v1/featured_tags/suggestions', async (c) => {
	await authenticate(c, 'read:accounts')
	const rows = await all<{ tag: string }>(
		c.env,
		"SELECT t.tag,COUNT(*) n FROM status_tags t JOIN statuses s ON s.id=t.status_id WHERE s.account_id=? AND s.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM account_tags a WHERE a.account_id=s.account_id AND a.tag=t.tag AND a.kind='feature') GROUP BY t.tag ORDER BY n DESC LIMIT 10",
		c.get('account').id
	)
	return c.json(await Promise.all(rows.map((t) => tagJSON(c.env, t.tag, c.get('account').id))))
})
