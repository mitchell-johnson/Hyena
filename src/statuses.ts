import { Hono } from 'hono'
import type { Context } from 'hono'
import { authenticate, optionalAccount } from './auth/access'
import { digest } from './auth/crypto'
import { isId, nextId } from './db'
import { ApiError, boolField, escapeHtml, readInput, stringField } from './http'
import { jobStatement, publishDue } from './jobs'
import { statusJSON, mediaJSON, visible } from './serializers'
import { audienceSQL } from './policy'
import type { AccountRow, AppEnv, Env, StatusRow, Visibility, MediaRow } from './types'
import { postExtras, characterCount } from './post-extras'
import { all, one, parsed } from './data'
import { attributes } from './organize'
import { scheduleStatus } from './status-actions'

export const statuses = new Hono<AppEnv>()
const allowed = new Set([
	'status',
	'spoiler_text',
	'visibility',
	'sensitive',
	'language',
	'in_reply_to_id',
	'media_ids',
	'media_attributes',
	'poll',
	'scheduled_at',
	'quoted_status_id',
	'quote_approval_policy',
])

export function normalize(input: Record<string, unknown>, previous?: StatusRow) {
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw new ApiError(422, `Unknown status field: ${key}`)
	const text = stringField(input, 'status', previous?.text ?? '').trim()
	const spoiler = stringField(input, 'spoiler_text', previous?.spoiler_text ?? '')
	if (characterCount(text + spoiler) > 500) throw new ApiError(422, 'Status and content warning exceed 500 characters')
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
	if (!row || !(await visible(c.env, row, viewer))) throw new ApiError(404, 'Record not found')
	return row
}

export async function writeStatus(
	env: Env,
	account: AccountRow,
	appId: string | null,
	input: Record<string, unknown>,
	previous?: StatusRow,
	requestKey: string | null = null,
	scheduledId: string | null = null
) {
	const owner = account.id
	const value = normalize(input, previous)
	const existingMedia = previous
		? (
				await env.DB.prepare('SELECT id FROM media_attachments WHERE status_id=? ORDER BY position')
					.bind(previous.id)
					.all<{ id: string }>()
			).results.map((m) => m.id)
		: []
	const media = value.media ?? existingMedia
	if (!value.text && !media.length) throw new ApiError(422, 'A status needs text or media')
	if (value.reply) {
		const parent = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', value.reply)
		if (!parent || !(await visible(env, parent, owner))) throw new ApiError(404, 'Record not found')
		if (['private', 'direct'].includes(parent.visibility) && value.visibility !== parent.visibility)
			throw new ApiError(422, 'A reply must preserve the restricted parent visibility')
	}
	const id = previous?.id ?? (await nextId(env.DB)),
		mutation = crypto.randomUUID(),
		now = new Date().toISOString()
	const key = !previous ? requestKey : null
	if (key !== null && (!key.trim() || key.length > 128)) throw new ApiError(400, 'Invalid Idempotency-Key')
	const hash = key
		? await digest(
				JSON.stringify({
					...value,
					media,
					media_attributes: input.media_attributes ?? null,
					poll: input.poll ?? null,
					quote: input.quoted_status_id ?? null,
					quote_policy: input.quote_approval_policy ?? null,
				})
			)
		: null
	if (key) {
		const existing = await env.DB.prepare('SELECT * FROM statuses WHERE account_id=? AND request_key=?')
			.bind(owner, key)
			.first<StatusRow>()
		if (existing) {
			if (existing.request_hash !== hash || existing.deleted_at)
				throw new ApiError(409, 'This idempotency key was already used')
			return existing
		}
	}
	const mediaAttributes = attributes(input.media_attributes)
	for (const a of mediaAttributes) {
		if (!media.includes(String(a.id))) throw new ApiError(422, 'Media attributes must refer to attached media')
		if (a.description !== undefined && stringField(a, 'description').length > 1500)
			throw new ApiError(422, 'Media description exceeds 1500 characters')
		if (a.focus !== undefined) {
			const parts = stringField(a, 'focus').split(',').map(Number)
			if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || Math.abs(n) > 1))
				throw new ApiError(422, 'Invalid media focus')
		}
	}
	const extras = await postExtras(env, account, id, input, value.text, value.visibility, previous)
	value.content = extras.content
	if (extras.poll && media.length) throw new ApiError(422, 'A poll cannot also attach media')
	const placeholders = media.map(() => '?').join(',') || 'NULL'
	const guard = `${scheduledId ? "EXISTS(SELECT 1 FROM scheduled_statuses WHERE id=? AND account_id=? AND state='pending' AND scheduled_at<=?) AND " : ''}(SELECT COUNT(*) FROM media_attachments WHERE id IN (${placeholders}) AND account_id=? AND state='ready' AND (status_id IS NULL OR status_id=?) AND (scheduled_id IS NULL OR scheduled_id=?))=?`
	const mediaGuard = [
		...(scheduledId ? [scheduledId, owner, now] : []),
		...media,
		owner,
		previous?.id ?? '',
		scheduledId,
		media.length,
	]
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
		? env.DB.prepare(
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
		: env.DB.prepare(
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
		...extras.statements(mutation),
		env.DB.prepare(
			'UPDATE statuses SET application_id=?,conversation_id=COALESCE((SELECT conversation_id FROM statuses WHERE id=?),?) WHERE id=? AND mutation_id=?'
		).bind(appId, value.reply, value.visibility === 'direct' ? id : null, id, mutation),
		env.DB.prepare(
			'INSERT OR IGNORE INTO status_recipients(status_id,account_id,mentioned) SELECT ?,account_id,0 FROM statuses WHERE id=? AND EXISTS(SELECT 1 FROM statuses WHERE id=? AND mutation_id=?)'
		).bind(id, value.reply, id, mutation),
		env.DB.prepare(`UPDATE media_attachments SET status_id=NULL WHERE status_id=? AND ${ownedMutation}`).bind(
			id,
			id,
			mutation
		),
		...mediaAttributes.map((a) => {
			const focus = a.focus === undefined ? null : stringField(a, 'focus').split(',').map(Number)
			return env.DB.prepare(
				`UPDATE media_attachments SET description=CASE WHEN ? THEN ? ELSE description END,focus_x=COALESCE(?,focus_x),focus_y=COALESCE(?,focus_y) WHERE id=? AND ${ownedMutation}`
			).bind(
				+(a.description !== undefined),
				stringField(a, 'description') || null,
				focus?.[0] ?? null,
				focus?.[1] ?? null,
				String(a.id),
				id,
				mutation
			)
		}),
		...media.map((mediaId, position) =>
			env.DB.prepare(
				`UPDATE media_attachments SET status_id=?,scheduled_id=NULL,position=?,updated_at=? WHERE id=? AND ${ownedMutation}`
			).bind(id, position, Date.now(), mediaId, id, mutation)
		),
		env.DB.prepare(
			`INSERT INTO status_revisions(status_id,revision,snapshot,created_at) SELECT ?,?,?,? WHERE ${ownedMutation}`
		).bind(
			id,
			revision,
			JSON.stringify({
				...row,
				media_ids: media,
				media_attachments: await Promise.all(
					media.map(async (id) =>
						mediaJSON(env, {
							...(await one<MediaRow>(env, 'SELECT * FROM media_attachments WHERE id=?', id))!,
							...(mediaAttributes.find((a) => a.id === id)?.description !== undefined
								? {
										description: stringField(
											mediaAttributes.find((a) => a.id === id)!,
											'description'
										),
									}
								: {}),
						})
					)
				),
				poll: extras.poll ? { options: extras.poll.options.map((title) => ({ title })) } : null,
			}),
			now,
			id,
			mutation
		),
		jobStatement(env, `status:${id}:${revision}`, 'status.event', { statusId: id }, { id, mutation }),
	]
	if (scheduledId)
		statements.push(
			env.DB.prepare(
				`UPDATE scheduled_statuses SET state='done',status_id=? WHERE id=? AND state='pending' AND ${ownedMutation}`
			).bind(id, scheduledId, id, mutation)
		)
	if (/https?:\/\//.test(value.text) && ['public', 'unlisted'].includes(value.visibility))
		statements.push(jobStatement(env, `card:${id}:${revision}`, 'card.fetch', { statusId: id }, { id, mutation }))
	if (extras.quoteRequest) {
		const request = await extras.quoteRequest(mutation)
		statements.push(request)
	}
	try {
		const results = await env.DB.batch(statements)
		if (!results[0]?.meta.changes)
			throw new ApiError(previous ? 409 : 422, 'The status changed or its media is unavailable; refresh and retry')
	} catch (error) {
		if (
			key &&
			error instanceof Error &&
			error.message.includes('UNIQUE constraint failed: statuses.account_id, statuses.request_key')
		) {
			const existing = await env.DB.prepare('SELECT * FROM statuses WHERE account_id=? AND request_key=?')
				.bind(owner, key)
				.first<StatusRow>()
			if (existing && existing.request_hash === hash && !existing.deleted_at) return existing
			throw new ApiError(409, 'This idempotency key was already used')
		}
		throw error
	}
	return (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', id))!
}

async function mutate(c: Context<AppEnv>, previous?: StatusRow) {
	const input = await readInput(c.req.raw)
	if (!previous && input.scheduled_at)
		return c.json(await scheduleStatus(c.env, c.get('account'), c.get('token').app_id, input))
	const row = await writeStatus(
		c.env,
		c.get('account'),
		c.get('token').app_id,
		input,
		previous,
		c.req.header('Idempotency-Key') ?? null
	)
	c.executionCtx.waitUntil(publishDue(c.env))
	return c.json(await statusJSON(c.env, row, c.get('account').id))
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
		if (!item || !(await visible(c.env, item, viewer))) break
		ancestors.unshift(item)
		parent = item.in_reply_to_id
	}
	const policy = audienceSQL(viewer, 's')
	const children = await c.env.DB.prepare(
		`WITH RECURSIVE thread(id) AS (
 SELECT s.id FROM statuses s WHERE s.in_reply_to_id=? AND ${policy.sql}
 UNION SELECT s.id FROM statuses s JOIN thread t ON s.in_reply_to_id=t.id WHERE ${policy.sql} LIMIT 100)
 SELECT s.* FROM statuses s JOIN thread t ON s.id=t.id ORDER BY s.sequence`
	)
		.bind(row.id, ...policy.binds, ...policy.binds)
		.all<StatusRow>()

	return c.json({
		ancestors: await Promise.all(ancestors.map((s) => statusJSON(c.env, s, viewer))),
		descendants: await Promise.all(children.results.map((s) => statusJSON(c.env, s, viewer))),
	})
})

export { timeline } from './timelines'
