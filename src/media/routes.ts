import Busboy from '@fastify/busboy'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { authenticate } from '../auth/access'
import { randomToken } from '../auth/crypto'
import { isId, nextId } from '../db'
import { ApiError, readInput, stringField } from '../http'
import { jobStatement, publishDue } from '../jobs'
import { mediaJSON } from '../serializers'
import type { AppEnv, MediaKind, MediaRow } from '../types'
import { maxMediaBytes, MEDIA_TYPES } from './process'
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

media.post('/api/v2/media', async (c) => {
	await authenticate(c, 'write:media')
	const request = c.req.raw,
		maximum = maxMediaBytes(c.env)
	if (!request.body || !request.headers.get('content-type')?.startsWith('multipart/form-data;'))
		throw new ApiError(415, 'Use a multipart upload')
	if (Number(request.headers.get('content-length')) > maximum + 32_768)
		throw new ApiError(413, 'Upload exceeds the byte limit')
	let parser: InstanceType<typeof Busboy>
	try {
		parser = new Busboy({
			headers: { 'content-type': request.headers.get('content-type')! },
			limits: { files: 1, fields: 2, parts: 3, fileSize: maximum, fieldSize: 8000, fieldNameSize: 64, headerPairs: 32 },
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
		failure: unknown,
		total = 0
	const bounded = request.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				total += chunk.byteLength
				if (total > maximum + 32_768) throw new ApiError(413, 'Upload exceeds the byte limit')
				controller.enqueue(chunk)
			},
		})
	)
	const incoming = Readable.fromWeb(bounded as never)
	let committing = false
	try {
		await new Promise<void>((resolve, reject) => {
			parser.on('file', (name, file, _filename, _encoding, type) => {
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
		if (failure) throw failure
		if (count !== 1 || !bytes) throw new ApiError(422, 'Exactly one file is required')
		const value = fields(input)
		committing = true
		await c.env.DB.batch([
			c.env.DB.prepare(
				`UPDATE media_attachments SET state='uploaded',mime_type=?,media_type=?,bytes=?,description=?,focus_x=?,focus_y=?,updated_at=? WHERE id=?`
			).bind(mime, kind, bytes, value.description, value.x, value.y, now, id),
			jobStatement(c.env, `media:${id}`, 'media.process', { mediaId: id }),
		])
		c.executionCtx.waitUntil(publishDue(c.env))
		const row = await c.env.DB.prepare('SELECT * FROM media_attachments WHERE id=?').bind(id).first<MediaRow>()
		return c.json(mediaJSON(c.env, row!), 202)
	} catch (error) {
		// A commit response can be ambiguous; leave durable intent and R2 intact.
		if (committing) throw error
		incoming.destroy()
		parser.destroy()
		await upload?.catch(() => {})
		await c.env.MEDIA_BUCKET.delete(key)
		await c.env.DB.prepare("DELETE FROM media_attachments WHERE id=? AND state='uploading'").bind(id).run()
		if (error instanceof ApiError) throw error
		throw new ApiError(400, 'Unable to complete the multipart upload')
	}
})
media.get('/api/v1/media/:id', async (c) => {
	await authenticate(c, 'write:media')
	const id = c.req.param('id')
	if (!isId(id)) throw new ApiError(404, 'Record not found')
	const row = await c.env.DB.prepare('SELECT * FROM media_attachments WHERE id=? AND account_id=?')
		.bind(id, c.get('account').id)
		.first<MediaRow>()
	if (!row) throw new ApiError(404, 'Record not found')
	if (row.state === 'failed') throw new ApiError(422, row.error ?? 'Media processing failed')
	if (row.state !== 'ready') return c.body(null, 206)
	return c.json(mediaJSON(c.env, row))
})
media.put('/api/v1/media/:id', async (c) => {
	await authenticate(c, 'write:media')
	const input = await readInput(c.req.raw)
	const row = await c.env.DB.prepare('SELECT * FROM media_attachments WHERE id=? AND account_id=?')
		.bind(c.req.param('id'), c.get('account').id)
		.first<MediaRow>()
	if (!row) throw new ApiError(404, 'Record not found')
	if (row.status_id) throw new ApiError(422, 'Editing attached media is not implemented yet')
	for (const key of Object.keys(input))
		if (!['description', 'focus'].includes(key)) throw new ApiError(422, `Unsupported field: ${key}`)
	const value = fields({ description: row.description ?? '', focus: `${row.focus_x},${row.focus_y}`, ...input })
	const updated = await c.env.DB.prepare(
		'UPDATE media_attachments SET description=?,focus_x=?,focus_y=?,updated_at=? WHERE id=? AND status_id IS NULL'
	)
		.bind(value.description, value.x, value.y, Date.now(), row.id)
		.run()
	if (!updated.meta.changes) throw new ApiError(409, 'The attachment changed; refresh and retry')
	return c.json(mediaJSON(c.env, { ...row, description: value.description, focus_x: value.x, focus_y: value.y }))
})

media.get('/media/:capability/:variant', async (c) => {
	const capability = c.req.param('capability'),
		variant = c.req.param('variant')
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(capability) ||
		!['image.webp', 'preview.webp', 'video.mp4', 'preview.jpg', 'audio.mp3'].includes(variant)
	)
		throw new ApiError(404, 'Record not found')
	const object = await c.env.MEDIA_BUCKET.get(`public/${capability}/${variant}`, {
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
	if (!('body' in object)) return new Response(null, { status: 304, headers })
	if (object.range && 'offset' in object.range && object.range.offset !== undefined) {
		const length = object.range.length ?? object.size - object.range.offset
		headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + length - 1}/${object.size}`)
		headers.set('Content-Length', String(length))
		return new Response(object.body, { status: 206, headers })
	}
	headers.set('Content-Length', String(object.size))
	return new Response(object.body, { headers })
})
