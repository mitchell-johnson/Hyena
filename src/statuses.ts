import { Hono } from 'hono'
import type { Context } from 'hono'
import { authenticate, optionalAccount } from './auth/access'
import { digest } from './auth/crypto'
import { isId, nextId } from './db'
import { ApiError, boolField, escapeHtml, readInput, stringField } from './http'
import { jobStatement, publishDue } from './jobs'
import { statusJSON, visible } from './serializers'
import type { AppEnv, StatusRow, Visibility } from './types'

export const statuses = new Hono<AppEnv>()
const allowed = new Set([
	'status',
	'spoiler_text',
	'visibility',
	'sensitive',
	'language',
	'in_reply_to_id',
	'media_ids',
])

function normalize(input: Record<string, unknown>, previous?: StatusRow) {
	for (const key of Object.keys(input))
		if (!allowed.has(key)) throw new ApiError(422, `${key} is not implemented in this milestone`)
	const text = stringField(input, 'status', previous?.text ?? '').trim()
	const spoiler = stringField(input, 'spoiler_text', previous?.spoiler_text ?? '')
	if ([...new Intl.Segmenter().segment(text + spoiler)].length > 500)
		throw new ApiError(422, 'Status and content warning exceed 500 characters')
	// Remote mentions need address resolution, delivery, and audience checks.
	// Reject until federation is wired so the composer cannot claim delivery.
	if (/(^|\s)@[\w]+(?:@[\w.-]+)?/u.test(text)) throw new ApiError(422, 'Mentions are not implemented yet')
	const visibility = stringField(input, 'visibility', previous?.visibility ?? 'public') as Visibility
	if (!['public', 'unlisted', 'private', 'direct'].includes(visibility)) throw new ApiError(422, 'Invalid visibility')
	if (previous && visibility !== previous.visibility)
		throw new ApiError(422, 'An existing status cannot change visibility')
	const reply = stringField(input, 'in_reply_to_id', previous?.in_reply_to_id ?? '')
	if (reply && !isId(reply)) throw new ApiError(422, 'Invalid reply ID')
	if (previous && reply !== (previous.in_reply_to_id ?? ''))
		throw new ApiError(422, 'An existing status cannot change its reply target')
	const language = stringField(input, 'language', previous?.language ?? '')
	if (language && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) throw new ApiError(422, 'Invalid language')
	const media = input.media_ids
	if (
		media !== undefined &&
		(!Array.isArray(media) ||
			media.length > 4 ||
			media.some((id) => typeof id !== 'string' || !isId(id)) ||
			new Set(media).size !== media.length)
	)
		throw new ApiError(422, 'media_ids must contain up to four unique IDs')
	return {
		text,
		content: text ? '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>' : '',
		spoiler,
		visibility,
		sensitive: boolField(input, 'sensitive', Boolean(previous?.sensitive)) ? 1 : 0,
		language: language || null,
		reply: reply || null,
		media: media as string[] | undefined,
	}
}

async function load(c: Context<AppEnv>, id: string, viewer: string | null) {
	if (!isId(id)) throw new ApiError(404, 'Record not found')
	const row = await c.env.DB.prepare('SELECT * FROM statuses WHERE id=?').bind(id).first<StatusRow>()
	if (!row || !visible(row, viewer)) throw new ApiError(404, 'Record not found')
	return row
}

async function mutate(c: Context<AppEnv>, previous?: StatusRow) {
	const owner = c.get('account').id
	const input = await readInput(c.req.raw),
		value = normalize(input, previous)
	const existingMedia = previous
		? (
				await c.env.DB.prepare('SELECT id FROM media_attachments WHERE status_id=? ORDER BY position')
					.bind(previous.id)
					.all<{ id: string }>()
			).results.map((m) => m.id)
		: []
	const media = value.media ?? existingMedia
	if (!value.text && !media.length) throw new ApiError(422, 'A status needs text or media')
	if (value.reply) {
		const parent = await load(c, value.reply, owner)
		if (['private', 'direct'].includes(parent.visibility) && value.visibility !== parent.visibility)
			throw new ApiError(422, 'A reply must preserve the restricted parent visibility')
	}
	const id = previous?.id ?? (await nextId(c.env.DB)),
		mutation = crypto.randomUUID(),
		now = new Date().toISOString()
	const key = !previous ? (c.req.header('Idempotency-Key') ?? null) : null
	if (key !== null && (!key.trim() || key.length > 128)) throw new ApiError(400, 'Invalid Idempotency-Key')
	const hash = key ? await digest(JSON.stringify({ ...value, media })) : null
	if (key) {
		const existing = await c.env.DB.prepare('SELECT * FROM statuses WHERE account_id=? AND request_key=?')
			.bind(owner, key)
			.first<StatusRow>()
		if (existing) {
			if (existing.request_hash !== hash || existing.deleted_at)
				throw new ApiError(409, 'This idempotency key was already used')
			return c.json(await statusJSON(c.env, existing, owner))
		}
	}
	const placeholders = media.map(() => '?').join(',') || 'NULL'
	const guard = `(SELECT COUNT(*) FROM media_attachments WHERE id IN (${placeholders}) AND account_id=? AND state='ready' AND (status_id IS NULL OR status_id=?))=?`
	const mediaGuard = [...media, owner, previous?.id ?? '', media.length]
	const revision = (previous?.revision ?? 0) + 1
	const row: StatusRow = {
		id,
		account_id: owner,
		text: value.text,
		content: value.content,
		spoiler_text: value.spoiler,
		visibility: value.visibility,
		sensitive: value.sensitive,
		language: value.language,
		in_reply_to_id: value.reply,
		created_at: previous?.created_at ?? now,
		edited_at: previous ? now : null,
		deleted_at: null,
		revision,
		mutation_id: mutation,
		request_key: key,
		request_hash: hash,
	}
	const write = previous
		? c.env.DB.prepare(
				`UPDATE statuses SET text=?,content=?,spoiler_text=?,sensitive=?,language=?,edited_at=?,revision=?,mutation_id=? WHERE id=? AND account_id=? AND revision=? AND deleted_at IS NULL AND ${guard}`
			).bind(
				row.text,
				row.content,
				row.spoiler_text,
				row.sensitive,
				row.language,
				now,
				revision,
				mutation,
				id,
				owner,
				previous.revision,
				...mediaGuard
			)
		: c.env.DB.prepare(
				`INSERT INTO statuses(id,sequence,account_id,text,content,spoiler_text,visibility,sensitive,language,in_reply_to_id,created_at,mutation_id,request_key,request_hash)
      SELECT ?,CAST(? AS INTEGER),?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`
			).bind(
				id,
				id,
				owner,
				row.text,
				row.content,
				row.spoiler_text,
				row.visibility,
				row.sensitive,
				row.language,
				row.in_reply_to_id,
				now,
				mutation,
				key,
				hash,
				...mediaGuard
			)
	const ownedMutation = 'EXISTS(SELECT 1 FROM statuses WHERE id=? AND mutation_id=?)'
	const statements = [
		write,
		c.env.DB.prepare(`UPDATE media_attachments SET status_id=NULL WHERE status_id=? AND ${ownedMutation}`).bind(
			id,
			id,
			mutation
		),
		...media.map((mediaId, position) =>
			c.env.DB.prepare(
				`UPDATE media_attachments SET status_id=?,position=?,updated_at=? WHERE id=? AND ${ownedMutation}`
			).bind(id, position, Date.now(), mediaId, id, mutation)
		),
		c.env.DB.prepare(
			`INSERT INTO status_revisions(status_id,revision,snapshot,created_at) SELECT ?,?,?,? WHERE ${ownedMutation}`
		).bind(id, revision, JSON.stringify({ ...row, media_ids: media }), now, id, mutation),
		jobStatement(c.env, `status:${id}:${revision}`, 'status.event', { statusId: id }, { id, mutation }),
	]
	try {
		const results = await c.env.DB.batch(statements)
		if (!results[0]?.meta.changes)
			throw new ApiError(previous ? 409 : 422, 'The status changed or its media is unavailable; refresh and retry')
	} catch (error) {
		if (
			key &&
			error instanceof Error &&
			error.message.includes('UNIQUE constraint failed: statuses.account_id, statuses.request_key')
		) {
			const existing = await c.env.DB.prepare('SELECT * FROM statuses WHERE account_id=? AND request_key=?')
				.bind(owner, key)
				.first<StatusRow>()
			if (existing && existing.request_hash === hash && !existing.deleted_at)
				return c.json(await statusJSON(c.env, existing, owner))
			throw new ApiError(409, 'This idempotency key was already used')
		}
		throw error
	}
	c.executionCtx.waitUntil(publishDue(c.env))
	return c.json(await statusJSON(c.env, row, owner))
}

statuses.post('/api/v1/statuses', async (c) => {
	await authenticate(c, 'write:statuses')
	return mutate(c)
})
statuses.put('/api/v1/statuses/:id', async (c) => {
	await authenticate(c, 'write:statuses')
	const row = await load(c, c.req.param('id'), c.get('account').id)
	if (row.account_id !== c.get('account').id) throw new ApiError(404, 'Record not found')
	return mutate(c, row)
})
statuses.delete('/api/v1/statuses/:id', async (c) => {
	await authenticate(c, 'write:statuses')
	const owner = c.get('account').id,
		row = await load(c, c.req.param('id'), owner)
	if (row.account_id !== owner) throw new ApiError(404, 'Record not found')
	const response = await statusJSON(c.env, row, owner),
		mutation = crypto.randomUUID()
	const result = await c.env.DB.batch([
		c.env.DB.prepare(
			'UPDATE statuses SET deleted_at=?,revision=revision+1,mutation_id=? WHERE id=? AND account_id=? AND revision=? AND deleted_at IS NULL'
		).bind(new Date().toISOString(), mutation, row.id, owner, row.revision),
		jobStatement(
			c.env,
			`status:${row.id}:${row.revision + 1}`,
			'status.event',
			{ statusId: row.id },
			{ id: row.id, mutation }
		),
	])
	if (!result[0]?.meta.changes) throw new ApiError(409, 'The status changed; refresh and retry')
	c.executionCtx.waitUntil(publishDue(c.env))
	return c.json(response)
})
statuses.get('/api/v1/statuses/:id', async (c) => {
	const viewer = await optionalAccount(c)
	return c.json(await statusJSON(c.env, await load(c, c.req.param('id'), viewer), viewer))
})
statuses.get('/api/v1/statuses/:id/source', async (c) => {
	await authenticate(c, 'read:statuses')
	const row = await load(c, c.req.param('id'), c.get('account').id)
	if (row.account_id !== c.get('account').id) throw new ApiError(404, 'Record not found')
	return c.json({ id: row.id, text: row.text, spoiler_text: row.spoiler_text })
})
statuses.get('/api/v1/statuses/:id/context', async (c) => {
	const viewer = await optionalAccount(c),
		row = await load(c, c.req.param('id'), viewer)
	const ancestors: StatusRow[] = []
	let parent = row.in_reply_to_id
	while (parent && ancestors.length < 40) {
		const item = await c.env.DB.prepare('SELECT * FROM statuses WHERE id=?').bind(parent).first<StatusRow>()
		if (!item || !visible(item, viewer)) break
		ancestors.unshift(item)
		parent = item.in_reply_to_id
	}
	const children = await c.env.DB.prepare(
		`WITH RECURSIVE thread(id) AS (
    SELECT id FROM statuses WHERE in_reply_to_id=? AND deleted_at IS NULL AND (visibility IN ('public','unlisted') OR account_id=?)
    UNION ALL SELECT s.id FROM statuses s JOIN thread t ON s.in_reply_to_id=t.id WHERE s.deleted_at IS NULL AND (s.visibility IN ('public','unlisted') OR s.account_id=?) LIMIT 100)
    SELECT s.* FROM statuses s JOIN thread t ON s.id=t.id ORDER BY s.sequence`
	)
		.bind(row.id, viewer, viewer)
		.all<StatusRow>()
	return c.json({
		ancestors: await Promise.all(ancestors.map((s) => statusJSON(c.env, s, viewer))),
		descendants: await Promise.all(children.results.map((s) => statusJSON(c.env, s, viewer))),
	})
})

export async function timeline(c: Context<AppEnv>, mode: 'public' | 'home' | 'account', accountId?: string) {
	const viewer = mode === 'home' ? (await authenticate(c, 'read:statuses')).account_id : await optionalAccount(c)
	const limitRaw = c.req.query('limit') ?? '20'
	if (!/^\d+$/.test(limitRaw)) throw new ApiError(400, 'Invalid limit')
	const limit = Math.min(40, Math.max(1, Number(limitRaw)))
	const clauses = ['deleted_at IS NULL'],
		binds: (string | number | null)[] = []
	if (mode === 'public') clauses.push("visibility='public'")
	else {
		clauses.push('account_id=?')
		binds.push(mode === 'home' ? viewer : accountId!)
		clauses.push("(visibility IN ('public','unlisted') OR account_id=?)")
		binds.push(viewer)
	}
	for (const [name, operator] of [
		['max_id', '<'],
		['since_id', '>'],
		['min_id', '>'],
	] as const) {
		const value = c.req.query(name)
		if (value) {
			if (!isId(value)) throw new ApiError(400, `Invalid ${name}`)
			clauses.push(`sequence ${operator} CAST(? AS INTEGER)`)
			binds.push(value)
		}
	}
	if (c.req.query('only_media') === 'true')
		clauses.push('EXISTS(SELECT 1 FROM media_attachments WHERE status_id=statuses.id)')
	if (c.req.query('exclude_replies') === 'true') clauses.push('in_reply_to_id IS NULL')
	// min_id asks for the page immediately newer than the cursor.
	const ascending = Boolean(c.req.query('min_id'))
	const rows = (
		await c.env.DB.prepare(
			`SELECT * FROM statuses WHERE ${clauses.join(' AND ')} ORDER BY sequence ${ascending ? 'ASC' : 'DESC'} LIMIT ?`
		)
			.bind(...binds, limit)
			.all<StatusRow>()
	).results
	if (ascending) rows.reverse()
	if (rows.length) {
		const next = new URL(c.req.url)
		next.searchParams.delete('min_id')
		next.searchParams.delete('since_id')
		next.searchParams.set('max_id', rows.at(-1)!.id)
		const prev = new URL(c.req.url)
		prev.searchParams.delete('max_id')
		prev.searchParams.delete('since_id')
		prev.searchParams.set('min_id', rows[0]!.id)
		c.header('Link', `<${next}>; rel="next", <${prev}>; rel="prev"`)
	}
	return c.json(await Promise.all(rows.map((row) => statusJSON(c.env, row, viewer))))
}
statuses.get('/api/v1/timelines/public', (c) => timeline(c, 'public'))
statuses.get('/api/v1/timelines/home', (c) => timeline(c, 'home'))
