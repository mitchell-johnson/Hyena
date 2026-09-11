import { accountDomain } from './identity'
import { archiveStream } from './archive'
import { relationshipEventJSON, type RelationshipEvent } from './severance'
import { federation } from './federation'
import { persistActor, persistStatus } from './federation/receive'
import { isActor } from '@fedify/vocab'
import { Hono } from 'hono'
import { requireWeb } from './auth/security'
import { verifyPassword, digest, randomToken } from './auth/crypto'
import { all, one, run, now, parsed, accountById, accountUri, object, type Bind } from './data'
import { ApiError, readInput, stringField, boolField } from './http'
import { nextId } from './db'
import { accountJSON, statusJSON } from './serializers'
import { resolveAccount, actorDocument } from './federation'
import { activityObject } from './federation/objects'
import { outboundStatement } from './federation/outbox'
import { blocked, visible } from './policy'
import type { AppEnv, Env, AccountRow, StatusRow, MediaRow } from './types'

export const lifecycle = new Hono<AppEnv>()
export function parseCSV(text: string): string[][] {
	if (text.length > 2_000_000) throw new ApiError(413, 'Import exceeds 2 MB')
	const rows: string[][] = []
	let row: string[] = [],
		value = '',
		quoted = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!
		if (ch === '"') {
			if (quoted && text[i + 1] === '"') {
				value += '"'
				i++
			} else if (quoted || value === '') quoted = !quoted
			else throw new ApiError(422, 'Invalid CSV quoting')
		} else if (ch === ',' && !quoted) {
			row.push(value)
			value = ''
		} else if ((ch === '\n' || ch === '\r') && !quoted) {
			if (ch === '\r' && text[i + 1] === '\n') i++
			row.push(value)
			if (row.some((v) => v)) rows.push(row)
			row = []
			value = ''
		} else value += ch
		if (rows.length > 10000 || row.length > 20 || value.length > 8192)
			throw new ApiError(422, 'Import exceeds row or field limits')
	}
	if (quoted) throw new ApiError(422, 'Unterminated CSV quote')
	row.push(value)
	if (row.some((v) => v)) rows.push(row)
	return rows
}
const csv = (rows: unknown[][]) =>
	rows.map((row) => row.map((v) => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n'
lifecycle.get('/api/hyena/severed_relationships', async (c) => {
	const { account } = await requireWeb(c)
	const rows = await all<RelationshipEvent>(
		c.env,
		'SELECT * FROM relationship_events WHERE account_id=? ORDER BY CAST(id AS INTEGER) DESC LIMIT 100',
		account.id
	)
	return c.json(await Promise.all(rows.map((row) => relationshipEventJSON(c.env, row))))
})
lifecycle.get('/api/hyena/severed_relationships/:id/:file', async (c) => {
	const { account } = await requireWeb(c),
		file = c.req.param('file'),
		direction = file.endsWith('.csv') ? file.slice(0, -4) : ''
	if (
		!['following', 'followers'].includes(direction) ||
		!(await one(c.env, 'SELECT 1 FROM relationship_events WHERE id=? AND account_id=?', c.req.param('id'), account.id))
	)
		throw new ApiError(404, 'Record not found')
	const rows = await all<{ address: string; reblogs: number; notify: number; languages: string }>(
		c.env,
		'SELECT * FROM severed_relationships WHERE event_id=? AND direction=? ORDER BY address',
		c.req.param('id'),
		direction
	)
	c.header('Content-Disposition', `attachment; filename="${direction}-${c.req.param('id')}.csv"`)
	return c.body(
		csv([
			['Account address', 'Show boosts', 'Notify on new posts', 'Languages'],
			...rows.map((r) => [r.address, !!r.reblogs, !!r.notify, parsed<string[]>(r.languages, []).join(',')]),
		]),
		200,
		{ 'Content-Type': 'text/csv; charset=utf-8' }
	)
})
lifecycle.get('/api/hyena/export/:file', async (c) => {
	const { account: a } = await requireWeb(c),
		file = c.req.param('file'),
		type = file.endsWith('.csv') ? file.slice(0, -4) : ''
	let rows: unknown[][] = []
	if (type === 'following') {
		rows = [
			['Account address', 'Show boosts', 'Notify on new posts', 'Languages'],
			...(
				await all<AccountRow & { reblogs: number; notify: number; languages: string }>(
					c.env,
					"SELECT a.*,f.reblogs,f.notify,f.languages FROM follows f JOIN accounts a ON a.id=f.following_id WHERE f.follower_id=? AND f.state='accepted'",
					a.id
				)
			).map((r) => [
				r.username + '@' + (r.domain || accountDomain(c.env)),
				!!r.reblogs,
				!!r.notify,
				parsed<string[]>(r.languages, []).join(','),
			]),
		]
	} else if (type === 'blocks' || type === 'mutes') {
		rows = [
			['Account address', ...(type === 'mutes' ? ['Hide notifications'] : [])],
			...(
				await all<AccountRow & { value: string }>(
					c.env,
					'SELECT a.*,x.value FROM account_actions x JOIN accounts a ON a.id=x.target_id WHERE x.account_id=? AND x.kind=?',
					a.id,
					type === 'blocks' ? 'block' : 'mute'
				)
			).map((r) => [
				r.username + '@' + (r.domain || accountDomain(c.env)),
				...(type === 'mutes' ? [parsed<{ notifications?: boolean }>(r.value, {}).notifications !== false] : []),
			]),
		]
	} else if (type === 'domain_blocks') {
		rows = (await all<{ domain: string }>(c.env, 'SELECT domain FROM user_domain_blocks WHERE account_id=?', a.id)).map(
			(r) => [r.domain]
		)
	} else if (type === 'bookmarks') {
		rows = (
			await all<StatusRow & { username: string }>(
				c.env,
				"SELECT s.*,a.username FROM statuses s JOIN interactions i ON i.status_id=s.id JOIN accounts a ON a.id=s.account_id WHERE i.account_id=? AND i.kind='bookmark'",
				a.id
			)
		).map((r) => [r.uri ?? `${c.env.PUBLIC_ORIGIN}/users/${r.username}/statuses/${r.id}`])
	} else if (type === 'lists') {
		rows = [
			['List', 'Account address'],
			...(
				await all<{ title: string; username: string; domain: string }>(
					c.env,
					'SELECT l.title,a.username,a.domain FROM lists l JOIN list_accounts m ON m.list_id=l.id JOIN accounts a ON a.id=m.account_id WHERE l.account_id=?',
					a.id
				)
			).map((r) => [r.title, r.username + '@' + (r.domain || accountDomain(c.env))]),
		]
	} else throw new ApiError(404, 'Unknown export type')
	c.header('Content-Disposition', `attachment; filename="${type}.csv"`)
	return c.body(csv(rows), 200, { 'Content-Type': 'text/csv; charset=utf-8' })
})
lifecycle.post('/api/hyena/imports', async (c) => {
	const input = await readInput(c.req.raw, 2_100_000),
		{ account: a } = await requireWeb(c, input),
		kind = stringField(input, 'type'),
		mode = stringField(input, 'mode', 'merge')
	if (
		!['following', 'blocks', 'mutes', 'domain_blocks', 'bookmarks', 'lists'].includes(kind) ||
		!['merge', 'overwrite'].includes(mode)
	)
		throw new ApiError(422, 'Invalid import type or mode')
	const rows = parseCSV(stringField(input, 'data', stringField(input, 'csv')))
	if (rows[0]?.some((v) => /^(account address|list|hide notifications)$/i.test(v))) rows.shift()
	const id = await nextId(c.env.DB)
	await c.env.DB.batch([
		c.env.DB.prepare('INSERT INTO import_tasks(id,account_id,kind,mode,data,created_at) VALUES(?,?,?,?,?,?)').bind(
			id,
			a.id,
			kind,
			mode,
			JSON.stringify(rows),
			now()
		),
		c.env.DB.prepare("INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'account.import',?,?,?)").bind(
			'import:' + id + ':0',
			JSON.stringify({ importId: id }),
			Date.now(),
			Date.now()
		),
	])
	return c.json({ id, status: 'pending', rows: rows.length }, 202)
})
lifecycle.get('/api/hyena/imports', async (c) => {
	const { account: a } = await requireWeb(c)
	return c.json(
		(
			await all<{ id: string; kind: string; status: string; offset: number; errors: string }>(
				c.env,
				'SELECT id,kind,status,offset,errors FROM import_tasks WHERE account_id=? ORDER BY id DESC LIMIT 100',
				a.id
			)
		).map((r) => ({ ...r, type: r.kind, errors: parsed(r.errors, []) }))
	)
})
lifecycle.get('/api/hyena/imports/:id', async (c) => {
	const { account: a } = await requireWeb(c),
		row = await one<{ id: string; status: string; offset: number; errors: string }>(
			c.env,
			'SELECT id,status,offset,errors FROM import_tasks WHERE id=? AND account_id=?',
			c.req.param('id'),
			a.id
		)
	if (!row) throw new ApiError(404, 'Record not found')
	return c.json({ ...row, errors: JSON.parse(row.errors) })
})
interface ImportRow {
	id: string
	account_id: string
	kind: string
	mode: string
	data: string
	offset: number
	errors: string
	status: string
}
export async function processImport(env: Env, id: string) {
	const task = await one<ImportRow>(env, 'SELECT * FROM import_tasks WHERE id=?', id)
	if (!task || task.status === 'done') return
	const a = await accountById(env, task.account_id)
	if (a.disabled || a.suspended) throw new ApiError(422, 'Import account is disabled')
	const rows = parsed<string[][]>(task.data, []),
		errors = parsed<{ row: number; message: string }[]>(task.errors, []),
		last = Math.min(rows.length, task.offset + 10)
	// Overwrite is applied as a difference against the complete imported set, so
	// retries never erase successfully imported rows or reissue every follow.
	if (task.mode === 'overwrite' && task.offset === 0) {
		const addresses = new Set(rows.map((r) => r[0]?.toLowerCase()))
		if (task.kind === 'following') {
			const old = await all<AccountRow & { activity_uri: string }>(
				env,
				'SELECT a.*,f.activity_uri FROM follows f JOIN accounts a ON a.id=f.following_id WHERE f.follower_id=?',
				a.id
			)
			for (const r of old)
				if (!addresses.has((r.username + '@' + (r.domain || accountDomain(env))).toLowerCase()))
					await env.DB.batch([
						env.DB.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').bind(a.id, r.id),
						outboundStatement(
							env,
							a.id,
							{
								type: 'Undo',
								actor: accountUri(env, a),
								object: { id: r.activity_uri, type: 'Follow', actor: accountUri(env, a), object: accountUri(env, r) },
							},
							[r.id],
							`import-${id}-unfollow-${r.id}`
						),
					])
		} else if (task.kind === 'domain_blocks') {
			for (const r of await all<{ domain: string }>(
				env,
				'SELECT domain FROM user_domain_blocks WHERE account_id=?',
				a.id
			))
				if (!addresses.has(r.domain))
					await run(env, 'DELETE FROM user_domain_blocks WHERE account_id=? AND domain=?', a.id, r.domain)
		} else if (['blocks', 'mutes'].includes(task.kind)) {
			for (const r of await all<AccountRow>(
				env,
				'SELECT a.* FROM account_actions x JOIN accounts a ON a.id=x.target_id WHERE x.account_id=? AND kind=?',
				a.id,
				task.kind === 'blocks' ? 'block' : 'mute'
			))
				if (!addresses.has((r.username + '@' + (r.domain || accountDomain(env))).toLowerCase()))
					await run(
						env,
						'DELETE FROM account_actions WHERE account_id=? AND target_id=? AND kind=?',
						a.id,
						r.id,
						task.kind === 'blocks' ? 'block' : 'mute'
					)
		} else if (task.kind === 'bookmarks')
			await run(env, "DELETE FROM interactions WHERE account_id=? AND kind='bookmark'", a.id)
		else if (task.kind === 'lists')
			await run(env, 'DELETE FROM list_accounts WHERE list_id IN (SELECT id FROM lists WHERE account_id=?)', a.id)
	}
	for (let index = task.offset; index < last; index++) {
		const row = rows[index]!,
			value = (row[0] ?? '').trim()
		try {
			if (task.kind === 'domain_blocks') {
				if (!/^[a-z0-9.-]+$/i.test(value)) throw new ApiError(422, 'Invalid domain')
				await run(env, 'INSERT OR IGNORE INTO user_domain_blocks VALUES(?,?)', a.id, value.toLowerCase())
				continue
			}
			if (task.kind === 'bookmarks') {
				let s = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE uri=? OR url=?', value, value)
				if (!s) {
					const ctx = (await federation(env)).createContext(new URL(env.PUBLIC_ORIGIN), env),
						obj = await ctx.lookupObject(value)
					if (obj?.attributionId) {
						const actor = await ctx.lookupObject(obj.attributionId)
						if (actor && isActor(actor)) s = await persistStatus(ctx, obj, await persistActor(ctx, actor))
					}
				}
				if (!s || !(await visible(env, s, a.id))) throw new ApiError(422, 'The bookmarked post is unavailable')
				await run(
					env,
					"INSERT OR IGNORE INTO interactions(id,account_id,status_id,kind,created_at) VALUES(?,?,?,'bookmark',?)",
					await nextId(env.DB),
					a.id,
					s.id,
					now()
				)
				continue
			}
			const target = await resolveAccount(env, task.kind === 'lists' ? (row[1] ?? '') : value, undefined, a.username),
				rid = await nextId(env.DB)
			if (target.id === a.id) continue
			if (task.kind === 'following' || task.kind === 'lists') {
				if (await blocked(env, a.id, target.id)) throw new ApiError(422, 'Account is blocked')
				if (!(await one(env, 'SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', a.id, target.id))) {
					const activity = `${env.PUBLIC_ORIGIN}/activities/import-${id}-${index}`
					await env.DB.batch([
						env.DB.prepare(
							'INSERT OR IGNORE INTO follows(id,follower_id,following_id,state,reblogs,notify,languages,activity_uri,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
						).bind(
							rid,
							a.id,
							target.id,
							target.domain || target.locked ? 'pending' : 'accepted',
							row[1] === 'false' ? 0 : 1,
							row[2] === 'true' ? 1 : 0,
							JSON.stringify((row[3] ?? '').split(',').filter(Boolean)),
							activity,
							now()
						),
						outboundStatement(
							env,
							a.id,
							{ id: activity, type: 'Follow', actor: accountUri(env, a), object: accountUri(env, target) },
							[target.id],
							`import-${id}-${index}`
						),
					])
				}
				if (task.kind === 'lists') {
					const list = await one<{ id: string }>(
							env,
							'SELECT id FROM lists WHERE account_id=? AND title=?',
							a.id,
							value
						),
						listId = list?.id ?? (await nextId(env.DB))
					await env.DB.batch([
						env.DB.prepare('INSERT OR IGNORE INTO lists(id,account_id,title) VALUES(?,?,?)').bind(
							listId,
							a.id,
							value.slice(0, 100)
						),
						env.DB.prepare('INSERT OR IGNORE INTO list_accounts VALUES(?,?)').bind(listId, target.id),
					])
				}
			} else {
				const kind = task.kind === 'blocks' ? 'block' : 'mute'
				const statements = [
					env.DB.prepare(
						'INSERT OR IGNORE INTO account_actions(id,account_id,target_id,kind,value,created_at) VALUES(?,?,?,?,?,?)'
					).bind(rid, a.id, target.id, kind, JSON.stringify({ notifications: row[1] !== 'false' }), now()),
				]
				if (kind === 'block')
					statements.push(
						env.DB.prepare(
							'DELETE FROM follows WHERE (follower_id=? AND following_id=?) OR (follower_id=? AND following_id=?)'
						).bind(a.id, target.id, target.id, a.id),
						outboundStatement(
							env,
							a.id,
							{ type: 'Block', actor: accountUri(env, a), object: accountUri(env, target) },
							[target.id],
							`import-${id}-${index}`
						)
					)
				await env.DB.batch(statements)
			}
		} catch (error) {
			errors.push({
				row: index + 1,
				message: error instanceof ApiError ? error.message : 'Account could not be imported',
			})
		}
	}
	const statements = [
		env.DB.prepare('UPDATE import_tasks SET offset=?,status=?,errors=? WHERE id=? AND offset=?').bind(
			last,
			last === rows.length ? 'done' : 'pending',
			JSON.stringify(errors.slice(0, 1000)),
			id,
			task.offset
		),
	]
	if (last < rows.length)
		statements.push(
			env.DB.prepare(
				"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'account.import',?,?,?)"
			).bind('import:' + id + ':' + last, JSON.stringify({ importId: id }), Date.now(), Date.now())
		)
	await env.DB.batch(statements)
}
lifecycle.post('/api/hyena/exports', async (c) => {
	const input = await readInput(c.req.raw, 2_100_000),
		{ account: a } = await requireWeb(c, input),
		id = await nextId(c.env.DB),
		boundary =
			(
				await one<{ id: string }>(
					c.env,
					'SELECT id FROM statuses WHERE account_id=? ORDER BY sequence DESC LIMIT 1',
					a.id
				)
			)?.id ?? '0'
	if (await one(c.env, "SELECT 1 FROM account_exports WHERE account_id=? AND status='pending'", a.id))
		throw new ApiError(409, 'An export is already running')
	await c.env.DB.batch([
		c.env.DB.prepare(
			"INSERT INTO account_exports(id,account_id,status,created_at,expires_at,boundary) VALUES(?,?,'pending',?,?,?)"
		).bind(id, a.id, now(), new Date(Date.now() + 7 * 86400000).toISOString(), boundary),
		c.env.DB.prepare("INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'account.export',?,?,?)").bind(
			'export:' + id + ':0',
			JSON.stringify({ exportId: id }),
			Date.now(),
			Date.now()
		),
	])
	return c.json({ id, status: 'pending' }, 202)
})
export async function processExport(env: Env, id: string) {
	const ex = await one<{ account_id: string; status: string; boundary: string; cursor: string | null; pages: number }>(
		env,
		'SELECT * FROM account_exports WHERE id=?',
		id
	)
	if (!ex || ex.status !== 'pending') return
	const a = await accountById(env, ex.account_id),
		rows = await all<StatusRow>(
			env,
			'SELECT * FROM statuses WHERE account_id=? AND deleted_at IS NULL AND sequence<=CAST(? AS INTEGER) AND sequence<CAST(? AS INTEGER) ORDER BY sequence DESC LIMIT 20',
			a.id,
			ex.boundary,
			ex.cursor ?? '9223372036854775807'
		),
		key = `exports/${a.id}/${id}/${ex.pages}.json`
	const archiveMedia: Record<string, string> = {}
	for (const status of rows) {
		for (const media of await all<MediaRow>(
			env,
			"SELECT * FROM media_attachments WHERE status_id=? AND state='ready'",
			status.id
		)) {
			for (const kind of ['output_key', 'preview_key'] as const) {
				const original = media[kind]
				if (!original) continue
				const name = `media/${media.id}/${original.split('/').at(-1)}`,
					copy = await env.MEDIA_BUCKET.get(original)
				if (!copy) throw new ApiError(409, 'Media changed during archive creation; retry the export')
				await env.MEDIA_BUCKET.put(`exports/${a.id}/${id}/${name}`, copy.body, { httpMetadata: copy.httpMetadata })
				archiveMedia[original] = name
			}
		}
	}
	await env.MEDIA_BUCKET.put(
		`exports/${a.id}/${id}/details-${ex.pages}.json`,
		JSON.stringify({
			statuses: await Promise.all(
				rows.map(async (status) => ({
					status: await statusJSON(env, status, a.id),
					revisions: await all(
						env,
						'SELECT revision,snapshot,created_at FROM status_revisions WHERE status_id=? ORDER BY revision',
						status.id
					),
					poll: await one(env, 'SELECT * FROM polls WHERE status_id=?', status.id),
				}))
			),
			media: archiveMedia,
		}),
		{ httpMetadata: { contentType: 'application/json' } }
	)
	await env.MEDIA_BUCKET.put(
		key,
		JSON.stringify({
			type: 'OrderedCollectionPage',
			orderedItems: await Promise.all(rows.map((s) => activityObject(env, s))),
		}),
		{ httpMetadata: { contentType: 'application/activity+json' } }
	)
	const done = rows.length < 20,
		next = ex.pages + 1
	if (done) {
		const metadata = {
			actor: await actorDocument(env, a),
			account: await accountJSON(env, a, true),
			follows: await all(env, 'SELECT * FROM follows WHERE follower_id=? OR following_id=?', a.id, a.id),
			actions: await all(env, 'SELECT * FROM account_actions WHERE account_id=?', a.id),
			filters: await all(env, 'SELECT * FROM filters WHERE account_id=?', a.id),
			lists: await all(env, 'SELECT * FROM lists WHERE account_id=?', a.id),
			collections: await all(env, 'SELECT * FROM collections WHERE account_id=?', a.id),
			collection_items: await all(
				env,
				'SELECT i.* FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE c.account_id=?',
				a.id
			),
			list_accounts: await all(
				env,
				'SELECT m.* FROM list_accounts m JOIN lists l ON l.id=m.list_id WHERE l.account_id=?',
				a.id
			),
			filter_keywords: await all(
				env,
				'SELECT k.* FROM filter_keywords k JOIN filters f ON f.id=k.filter_id WHERE f.account_id=?',
				a.id
			),
			filter_statuses: await all(
				env,
				'SELECT k.* FROM filter_statuses k JOIN filters f ON f.id=k.filter_id WHERE f.account_id=?',
				a.id
			),
			domain_blocks: await all(env, 'SELECT * FROM user_domain_blocks WHERE account_id=?', a.id),
			interactions: await all(env, 'SELECT * FROM interactions WHERE account_id=?', a.id),
			scheduled_posts: await all(env, "SELECT * FROM scheduled_statuses WHERE account_id=? AND state='pending'", a.id),
			hashtags: await all(env, 'SELECT * FROM account_tags WHERE account_id=?', a.id),
			notification_policy: await one(env, 'SELECT policy FROM notification_policies WHERE account_id=?', a.id),
			poll_votes: await all(env, 'SELECT * FROM poll_votes WHERE account_id=?', a.id),
			created_at: now(),
			format: 'hyena-activitystreams-1',
			outbox_pages: next,
		}
		await env.MEDIA_BUCKET.put(`exports/${a.id}/${id}/manifest.json`, JSON.stringify(metadata), {
			httpMetadata: { contentType: 'application/json' },
		})
	}
	const statements = [
		env.DB.prepare('UPDATE account_exports SET cursor=?,pages=?,status=?,object_key=? WHERE id=? AND pages=?').bind(
			rows.at(-1)?.id ?? ex.cursor,
			next,
			done ? 'ready' : 'pending',
			`exports/${a.id}/${id}/manifest.json`,
			id,
			ex.pages
		),
	]
	if (!done)
		statements.push(
			env.DB.prepare(
				"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'account.export',?,?,?)"
			).bind('export:' + id + ':' + next, JSON.stringify({ exportId: id }), Date.now(), Date.now())
		)
	await env.DB.batch(statements)
}
lifecycle.get('/api/hyena/exports', async (c) => {
	const { account: a } = await requireWeb(c)
	return c.json(
		await all(
			c.env,
			'SELECT id,status,pages,created_at,expires_at FROM account_exports WHERE account_id=? ORDER BY id DESC',
			a.id
		)
	)
})
lifecycle.get('/api/hyena/exports/:id/:file', async (c) => {
	const { account: a } = await requireWeb(c),
		file = c.req.param('file')
	if (file !== 'archive.tar' && !/^(manifest|\d+)\.json$/.test(file)) throw new ApiError(404, 'Record not found')
	const ex = await one(
		c.env,
		"SELECT 1 FROM account_exports WHERE id=? AND account_id=? AND status='ready' AND expires_at>?",
		c.req.param('id'),
		a.id,
		now()
	)
	if (!ex) throw new ApiError(404, 'Record not found')
	if (file === 'archive.tar')
		return new Response(archiveStream(c.env, `exports/${a.id}/${c.req.param('id')}/`), {
			headers: {
				'Content-Type': 'application/x-tar',
				'Content-Disposition': `attachment; filename="hyena-${a.username}-${c.req.param('id')}.tar"`,
				'Cache-Control': 'no-store',
			},
		})
	const data = await c.env.MEDIA_BUCKET.get(`exports/${a.id}/${c.req.param('id')}/${file}`)
	if (!data) throw new ApiError(404, 'Record not found')
	return new Response(data.body, {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="${file}"`,
			'Cache-Control': 'no-store',
		},
	})
})
lifecycle.post('/api/hyena/account/aliases', async (c) => {
	const input = await readInput(c.req.raw),
		{ account: a } = await requireWeb(c, input),
		target = await resolveAccount(c.env, stringField(input, 'acct'), undefined, a.username),
		aliases = parsed<string[]>(a.aliases, []),
		uri = accountUri(c.env, target),
		remove = boolField(input, 'remove')
	if (target.id === a.id) throw new ApiError(422, 'Choose another account')
	const next = remove ? aliases.filter((x) => x !== uri) : [...new Set([...aliases, uri])]
	if (next.length > 10) throw new ApiError(422, 'Maximum ten aliases')
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE accounts SET aliases=? WHERE id=?').bind(JSON.stringify(next), a.id),
		c.env.DB.prepare("INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'account.event',?,?,?)").bind(
			'alias:' + crypto.randomUUID(),
			JSON.stringify({ accountId: a.id }),
			Date.now(),
			Date.now()
		),
	])
	return c.json({ aliases: next })
})
lifecycle.post('/api/hyena/account/move', async (c) => {
	const input = await readInput(c.req.raw),
		{ account: a } = await requireWeb(c, input)
	if (!verifyPassword(stringField(input, 'password'), a.password_hash))
		throw new ApiError(403, 'Current password is incorrect')
	const target = await resolveAccount(c.env, stringField(input, 'acct'), undefined, a.username)
	if (target.id === a.id || !parsed<string[]>(target.aliases, []).includes(accountUri(c.env, a)))
		throw new ApiError(422, 'The destination must first declare this account as an alias')
	const recipients = (
		await all<{ id: string }>(
			c.env,
			"SELECT follower_id id FROM follows WHERE following_id=? AND state='accepted'",
			a.id
		)
	).map((r) => r.id)
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE accounts SET moved_to_id=? WHERE id=?').bind(target.id, a.id),
		outboundStatement(
			c.env,
			a.id,
			{ type: 'Move', actor: accountUri(c.env, a), object: accountUri(c.env, a), target: accountUri(c.env, target) },
			recipients
		),
	])
	await migrateLocalFollowers(c.env, a, target)
	return c.json({ moved_to: await accountJSON(c.env, target) })
})
export async function migrateLocalFollowers(env: Env, source: AccountRow, target: AccountRow) {
	const followers = await all<AccountRow>(
		env,
		"SELECT a.* FROM follows f JOIN accounts a ON a.id=f.follower_id WHERE f.following_id=? AND f.state='accepted' AND a.domain=''",
		source.id
	)
	for (const a of followers) {
		if (await blocked(env, a.id, target.id)) continue
		const id = await nextId(env.DB),
			activity = `${env.PUBLIC_ORIGIN}/activities/move-follow-${source.id}-${target.id}-${a.id}`
		await env.DB.batch([
			env.DB.prepare(
				'INSERT OR IGNORE INTO follows(id,follower_id,following_id,state,activity_uri,created_at) VALUES(?,?,?,?,?,?)'
			).bind(id, a.id, target.id, target.domain || target.locked ? 'pending' : 'accepted', activity, now()),
			env.DB.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').bind(a.id, source.id),
			outboundStatement(
				env,
				a.id,
				{ id: activity, type: 'Follow', actor: accountUri(env, a), object: accountUri(env, target) },
				[target.id],
				`move-follow-${source.id}-${target.id}-${a.id}`
			),
		])
	}
}
lifecycle.post('/api/hyena/account/delete', async (c) => {
	const input = await readInput(c.req.raw),
		{ account: a } = await requireWeb(c, input)
	if (!verifyPassword(stringField(input, 'password'), a.password_hash) || stringField(input, 'username') !== a.username)
		throw new ApiError(403, 'Confirm your username and current password')
	await deleteAccount(c.env, a)
	return c.json({ deleted: true })
})
export async function deleteAccount(env: Env, a: AccountRow) {
	const recipients = (
			await all<{ id: string }>(
				env,
				'SELECT follower_id id FROM follows WHERE following_id=? UNION SELECT r.account_id id FROM status_recipients r JOIN statuses s ON s.id=r.status_id WHERE s.account_id=?',
				a.id,
				a.id
			)
		).map((r) => r.id),
		statements = [
			outboundStatement(
				env,
				a.id,
				{ type: 'Delete', actor: accountUri(env, a), object: { id: accountUri(env, a), type: 'Tombstone' } },
				recipients,
				'delete-account-' + a.id
			),
			env.DB.prepare(
				"UPDATE accounts SET disabled=1,suspended=1,display_name='',note='',email=NULL,avatar=NULL,header=NULL,avatar_media_id=NULL,header_media_id=NULL,fields='[]',preferences='{}',password_hash='' WHERE id=?"
			).bind(a.id),
			env.DB.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE account_id=?').bind(Date.now(), a.id),
			env.DB.prepare('DELETE FROM sessions WHERE account_id=?').bind(a.id),
			env.DB.prepare('DELETE FROM follows WHERE follower_id=? OR following_id=?').bind(a.id, a.id),
			env.DB.prepare(
				"UPDATE statuses SET deleted_at=?,revision=revision+1,text='',content='',spoiler_text='' WHERE account_id=? AND deleted_at IS NULL"
			).bind(now(), a.id),
			env.DB.prepare("UPDATE scheduled_statuses SET state='cancelled' WHERE account_id=? AND state='pending'").bind(
				a.id
			),
			env.DB.prepare(
				"UPDATE media_attachments SET status_id=NULL,scheduled_id=NULL,state='failed',error='Account deleted' WHERE account_id=?"
			).bind(a.id),
			env.DB.prepare('DELETE FROM passkeys WHERE account_id=?').bind(a.id),
			env.DB.prepare('DELETE FROM recovery_codes WHERE account_id=?').bind(a.id),
		]
	await env.DB.batch(statements)
	await env.STREAMS.get(env.STREAMS.idFromName(a.id)).revokeAll()
}
lifecycle.post('/api/hyena/invites', async (c) => {
	const input = await readInput(c.req.raw),
		{ account: a } = await requireWeb(c, input)
	if (a.role !== 'admin') throw new ApiError(403, 'Only the administrator can invite users')
	const code = randomToken(),
		max = Math.max(1, Math.min(100, Number(input.max_uses) || 1)),
		expires = Date.now() + Math.max(3600000, Math.min(30 * 86400000, Number(input.expires_in ?? 86400) * 1000))
	await run(
		c.env,
		'INSERT INTO invites(code_hash,expires_at,max_uses,created_by) VALUES(?,?,?,?)',
		await digest(code),
		expires,
		max,
		a.id
	)
	return c.json({
		url: `${c.env.PUBLIC_ORIGIN}/auth/sign_up?invite_code=${code}`,
		expires_at: new Date(expires).toISOString(),
		max_uses: max,
	})
})
