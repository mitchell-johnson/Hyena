import Busboy from '@fastify/busboy'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { authenticate } from '../auth/access'
import { randomToken } from '../auth/crypto'
import { isId, nextId } from '../db'
import { ApiError, boundedBytes, readInput, stringField } from '../http'
import { jobStatement, publishDue, executeJob } from '../jobs'
import { mediaJSON } from '../serializers'
import type { AppEnv, MediaKind, MediaRow } from '../types'
import { maxMediaBytes, MEDIA_TYPES, customThumbnail } from './process'
import { storeStream } from './storage'

export const media = new Hono<AppEnv>()
function fields(input: Record<string, unknown>) {
	const description = stringField(input, 'description')
	if ([...description].length > 1500) throw new ApiError(422, 'Description exceeds 1500 characters')
	const coordinates = stringField(input, 'focus', '0,0').split(',')
	if (coordinates.some((v) => !v.trim())) throw new ApiError(422, 'Invalid focus')
	const focus = coordinates.map(Number)
	if (focus.length !== 2 || focus.some((v) => !Number.isFinite(v) || Math.abs(v) > 1))
		throw new ApiError(422, 'Invalid focus')
	return { description: description || null, x: focus[0]!, y: focus[1]! }
}

media.on('POST', ['/api/v2/media', '/api/v1/media'], async (c) => {
	await authenticate(c, 'write:media')
	const request = c.req.raw,
		maximum = maxMediaBytes(c.env)
	if (!request.body || !request.headers.get('content-type')?.startsWith('multipart/form-data;'))
		throw new ApiError(415, 'Use a multipart upload')
	if (Number(request.headers.get('content-length')) > maximum + 2_032_768)
		throw new ApiError(413, 'Upload exceeds the byte limit')
	let parser: InstanceType<typeof Busboy>
	try {
		parser = new Busboy({
			headers: { 'content-type': request.headers.get('content-type')! },
			limits: { files: 2, fields: 2, parts: 4, fileSize: maximum, fieldSize: 8000, fieldNameSize: 64, headerPairs: 32 },
		})
	} catch {
		throw new ApiError(400, 'Invalid multipart boundary')
	}
	const id = await nextId(c.env.DB),
		key = `original/${randomToken()}/upload`,
		now = Date.now()
	// Reserve a cleanup record before touching R2; a disconnected request or
	// crashed isolate must not leave an untracked, billable object behind.
	await c.env.DB.prepare(
		`INSERT INTO media_attachments(id,account_id,state,original_key,mime_type,media_type,created_at,updated_at) VALUES(?,?,'uploading',?,'application/octet-stream','image',?,?)`
	)
		.bind(id, c.get('account').id, key, now, now)
		.run()
	const input: Record<string, unknown> = Object.create(null)
	let mime = '',
		kind: MediaKind = 'image',
		count = 0,
		upload: Promise<number> | undefined,
		thumbnail: Promise<number> | undefined,
		failure: unknown,
		total = 0
	const bounded = request.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				total += chunk.byteLength
				if (total > maximum + 2_032_768) throw new ApiError(413, 'Upload exceeds the byte limit')
				controller.enqueue(chunk)
			},
		})
	)
	const incoming = Readable.fromWeb(bounded as never)
	let committing = false
	try {
		await new Promise<void>((resolve, reject) => {
			parser.on('file', (name, file, _filename, _encoding, type) => {
				if (name === 'thumbnail') {
					if (thumbnail || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
						failure = new ApiError(415, 'Use one JPEG, PNG or WebP thumbnail')
						file.resume()
						return
					}
					thumbnail = storeStream(
						c.env.MEDIA_BUCKET,
						key.replace('/upload', '/thumbnail'),
						Readable.toWeb(file) as ReadableStream<Uint8Array>,
						type,
						2_000_000
					)
					thumbnail.catch((error) => {
						failure = error
						file.resume()
					})
					return
				}
				count++
				if (name !== 'file' || !MEDIA_TYPES.includes(type)) {
					failure = new ApiError(415, 'Unsupported media type')
					file.resume()
					return
				}
				mime = type
				kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'audio'
				file.on('limit', () => {
					failure = new ApiError(413, 'Upload exceeds the byte limit')
				})
				upload = storeStream(c.env.MEDIA_BUCKET, key, Readable.toWeb(file) as ReadableStream<Uint8Array>, mime, maximum)
				// Attach a rejection handler immediately, before parser completion.
				upload.catch((error) => {
					failure = error
					file.resume()
				})
			})
			parser.on('field', (name, value, nameTruncated, valueTruncated) => {
				if (!['description', 'focus'].includes(name) || input[name] !== undefined || nameTruncated || valueTruncated)
					failure = new ApiError(422, 'Invalid or duplicate media field')
				else input[name] = value
			})
			for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const)
				parser.on(event, () => {
					failure = new ApiError(422, 'Too many multipart fields')
				})
			parser.on('error', reject)
			incoming.on('error', reject)
			parser.on('finish', resolve)
			incoming.pipe(parser)
		})
		const bytes = await upload
		await thumbnail
		if (failure) throw failure
		if (count !== 1 || !bytes) throw new ApiError(422, 'Exactly one file is required')
		const value = fields(input)
		committing = true
		await c.env.DB.batch([
			c.env.DB.prepare(
				`UPDATE media_attachments SET state='uploaded',mime_type=?,media_type=?,bytes=?,description=?,focus_x=?,focus_y=?,updated_at=?,custom_preview_key=? WHERE id=?`
			).bind(
				mime,
				kind,
				bytes,
				value.description,
				value.x,
				value.y,
				now,
				thumbnail ? key.replace('/upload', '/thumbnail') : null,
				id
			),
			jobStatement(c.env, `media:${id}`, 'media.process', { mediaId: id }),
		])
		c.executionCtx.waitUntil(publishDue(c.env))
		if (c.req.path === '/api/v1/media') await executeJob(c.env, 'media:' + id)
		const row = await c.env.DB.prepare('SELECT * FROM media_attachments WHERE id=?').bind(id).first<MediaRow>()
		if (row?.state === 'failed') throw new ApiError(422, row.error ?? 'Media processing failed')
		return c.json(mediaJSON(c.env, row!), c.req.path === '/api/v1/media' ? 200 : 202)
	} catch (error) {
		// A commit response can be ambiguous; leave durable intent and R2 intact.
		if (committing) throw error
		incoming.destroy()
		parser.destroy()
		await upload?.catch(() => {})
		await thumbnail?.catch(() => {})
		await c.env.MEDIA_BUCKET.delete([key, key.replace('/upload', '/thumbnail')])
		await c.env.DB.prepare("DELETE FROM media_attachments WHERE id=? AND state='uploading'").bind(id).run()
		if (error instanceof ApiError) throw error
		throw new ApiError(400, 'Unable to complete the multipart upload')
	}
})
media.get('/api/v1/media/:id', async (c) => {
	await authenticate(c, 'write:media')
	const id = c.req.param('id')
	if (!isId(id)) throw new ApiError(404, 'Record not found')
	const row = await c.env.DB.prepare(
		'SELECT * FROM media_attachments WHERE id=? AND account_id=? AND status_id IS NULL'
	)
		.bind(id, c.get('account').id)
		.first<MediaRow>()
	if (!row) throw new ApiError(404, 'Record not found')
	if (row.state === 'failed') throw new ApiError(422, row.error ?? 'Media processing failed')
	if (row.state !== 'ready') return c.body(null, 206)
	return c.json(mediaJSON(c.env, row))
})
media.put('/api/v1/media/:id', async (c) => {
	await authenticate(c, 'write:media')
	const input: Record<string, unknown> = c.req.header('Content-Type')?.startsWith('multipart/form-data')
		? Object.fromEntries(
				await new Response(await boundedBytes(c.req.raw, 2_040_000), {
					headers: { 'Content-Type': c.req.header('Content-Type')! },
				}).formData()
			)
		: await readInput(c.req.raw)
	const row = await c.env.DB.prepare(
		'SELECT * FROM media_attachments WHERE id=? AND account_id=? AND status_id IS NULL'
	)
		.bind(c.req.param('id'), c.get('account').id)
		.first<MediaRow>()
	if (!row) throw new ApiError(404, 'Record not found')

	for (const key of Object.keys(input))
		if (!['description', 'focus', 'thumbnail'].includes(key)) throw new ApiError(422, `Unsupported field: ${key}`)
	if (input.thumbnail !== undefined) {
		if (row.state !== 'ready') throw new ApiError(422, 'Wait for media processing before changing its thumbnail')
		if (
			!(input.thumbnail instanceof File) ||
			input.thumbnail.size > 2_000_000 ||
			!['image/jpeg', 'image/png', 'image/webp'].includes(input.thumbnail.type)
		)
			throw new ApiError(422, 'Use a JPEG, PNG or WebP thumbnail up to 2 MB')
		row.preview_key = await customThumbnail(c.env, row, input.thumbnail.stream(), crypto.randomUUID())
	}
	const value = fields({ description: row.description ?? '', focus: `${row.focus_x},${row.focus_y}`, ...input })
	const updated = await c.env.DB.prepare(
		'UPDATE media_attachments SET description=?,focus_x=?,focus_y=?,updated_at=?,preview_key=? WHERE id=?'
	)
		.bind(value.description, value.x, value.y, Date.now(), row.preview_key, row.id)
		.run()
	if (!updated.meta.changes) throw new ApiError(409, 'The attachment changed; refresh and retry')
	return c.json(mediaJSON(c.env, { ...row, description: value.description, focus_x: value.x, focus_y: value.y }))
})

media.delete('/api/v1/media/:id', async (c) => {
	await authenticate(c, 'write:media')
	const row = await c.env.DB.prepare('SELECT * FROM media_attachments WHERE id=? AND account_id=?')
		.bind(c.req.param('id'), c.get('account').id)
		.first<MediaRow>()
	if (!row) throw new ApiError(404, 'Record not found')
	if (
		row.status_id ||
		row.scheduled_id ||
		(await c.env.DB.prepare('SELECT 1 FROM accounts WHERE avatar_media_id=? OR header_media_id=?')
			.bind(row.id, row.id)
			.first())
	)
		throw new ApiError(422, 'Detach this media before deleting it')
	const claim = await c.env.DB.prepare(
		"UPDATE media_attachments SET state='failed',error='Deleted' WHERE id=? AND status_id IS NULL AND scheduled_id IS NULL AND state<>'processing' AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.avatar_media_id=media_attachments.id OR a.header_media_id=media_attachments.id) AND NOT EXISTS(SELECT 1 FROM custom_emojis e WHERE e.url LIKE '%'||replace(media_attachments.output_key,'public/',''))"
	)
		.bind(row.id)
		.run()
	if (!claim.meta.changes) throw new ApiError(409, 'Media is attached or processing')
	await c.env.MEDIA_BUCKET.delete([
		row.original_key,
		...[row.output_key, row.preview_key, row.custom_preview_key].filter((x): x is string => !!x),
	])
	await c.env.DB.prepare('DELETE FROM media_attachments WHERE id=? AND status_id IS NULL AND scheduled_id IS NULL')
		.bind(row.id)
		.run()
	return c.json({})
})

media.get('/media/:capability/:variant', async (c) => {
	const capability = c.req.param('capability'),
		variant = c.req.param('variant')
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(capability) ||
		!['image.webp', 'preview.webp', 'video.mp4', 'preview.jpg', 'audio.mp3'].includes(variant)
	)
		throw new ApiError(404, 'Record not found')
	const key = `public/${capability}/${variant}`,
		record = await c.env.DB.prepare(
			"SELECT 1 FROM media_attachments m WHERE (output_key=? OR preview_key=?) AND state='ready' AND (status_id IS NULL OR EXISTS(SELECT 1 FROM statuses s WHERE s.id=m.status_id AND s.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM custom_emojis e WHERE e.url LIKE '%'||replace(m.output_key,'public/','')))"
		)
			.bind(key, key)
			.first()
	if (!record) throw new ApiError(404, 'Record not found')
	const object = await c.env.MEDIA_BUCKET.get(key, {
		range: c.req.raw.headers,
		onlyIf: c.req.raw.headers,
	})
	if (!object) throw new ApiError(404, 'Record not found')
	const headers = new Headers({
		'Cache-Control': 'private, max-age=300',
		'Accept-Ranges': 'bytes',
		'X-Content-Type-Options': 'nosniff',
	})
	object.writeHttpMetadata(headers)
	headers.set('ETag', object.httpEtag)
	if (!('body' in object))
		return new Response(null, {
			status: c.req.header('If-Match') || c.req.header('If-Unmodified-Since') ? 412 : 304,
			headers,
		})
	if (object.range && 'offset' in object.range && object.range.offset !== undefined) {
		const length = object.range.length ?? object.size - object.range.offset
		headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + length - 1}/${object.size}`)
		headers.set('Content-Length', String(length))
		return new Response(object.body, { status: 206, headers })
	}
	headers.set('Content-Length', String(object.size))
	return new Response(object.body, { headers })
})
