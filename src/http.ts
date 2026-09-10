import type { Context } from 'hono'
import type { AppEnv } from './types'

export const CONTENT_SECURITY_POLICY =
	"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: blob:; media-src 'self' https: blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

export class ApiError extends Error {
	constructor(
		public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 501 | 503,
		message: string,
		public code?: string
	) {
		super(message)
	}
}

export async function boundedBytes(message: Request | Response, limit: number): Promise<Uint8Array> {
	if (Number(message.headers.get('content-length')) > limit) throw new ApiError(413, 'Body too large')
	const reader = message.body?.getReader(),
		chunks: Uint8Array[] = []
	let length = 0
	if (reader)
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				length += value.byteLength
				if (length > limit) {
					await reader.cancel()
					throw new ApiError(413, 'Body too large')
				}
				chunks.push(value)
			}
		} finally {
			reader.releaseLock()
		}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

export async function readInput(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
	if (!request.body) return {}
	if (Number(request.headers.get('content-length')) > maxBytes) throw new ApiError(413, 'Request too large')
	const reader = request.body?.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	if (reader) {
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				size += value.byteLength
				if (size > maxBytes) {
					await reader.cancel()
					throw new ApiError(413, 'Request too large')
				}
				chunks.push(value)
			}
		} finally {
			reader.releaseLock()
		}
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.length
	}
	const text = new TextDecoder().decode(bytes)
	const contentType = request.headers.get('content-type') ?? ''
	const type = contentType.split(';')[0]?.trim().toLowerCase()
	if (type === 'application/json') {
		try {
			const result: unknown = JSON.parse(text)
			if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>
		} catch {
			/* Produce the same bounded client error for invalid JSON. */
		}
		throw new ApiError(400, 'Expected a JSON object')
	}
	let fields: Iterable<[string, string]>
	if (type === 'multipart/form-data') {
		let form: FormData
		try {
			// Parse only after enforcing the byte limit, then apply the same field
			// validation used for URL-encoded forms. File uploads have separate handlers.
			form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData()
		} catch {
			throw new ApiError(400, 'Invalid multipart form data')
		}
		const entries: [string, string][] = []
		for (const [key, value] of form) {
			if (typeof value !== 'string') throw new ApiError(400, 'File uploads are not supported for this request')
			entries.push([key, value])
		}
		fields = entries
	} else if (type === 'application/x-www-form-urlencoded') {
		fields = new URLSearchParams(text)
	} else {
		throw new ApiError(415, 'Use JSON, form-urlencoded or multipart form input')
	}
	const result: Record<string, unknown> = Object.create(null)
	for (const [key, value] of fields) {
		if (!/^[A-Za-z0-9_:-]+(?:\[[A-Za-z0-9_:-]*\])*$/.test(key)) throw new ApiError(400, 'Invalid form field')
		const parts = [...key.matchAll(/([^\[\]]+)|\[()\]/g)].map((m) => m[1] ?? '')
		if (parts.length > 6 || parts.some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)))
			throw new ApiError(400, 'Invalid form field')
		let target: Record<string, unknown> | unknown[] = result
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!,
				last = i === parts.length - 1
			if (part === '') {
				if (!last || !Array.isArray(target)) throw new ApiError(400, 'Invalid form array')
				target.push(value)
				break
			}
			const obj = target as Record<string, unknown>
			if (last) {
				if (Object.hasOwn(obj, part)) throw new ApiError(400, 'Duplicate form field')
				obj[part] = value
			} else {
				if (!Object.hasOwn(obj, part)) obj[part] = parts[i + 1] === '' ? [] : Object.create(null)
				if (!obj[part] || typeof obj[part] !== 'object') throw new ApiError(400, 'Conflicting form fields')
				target = obj[part] as Record<string, unknown>
			}
		}
	}
	return result
}

export function stringField(input: Record<string, unknown>, key: string, fallback = ''): string {
	if (input[key] === undefined || input[key] === null) return fallback
	if (typeof input[key] !== 'string') throw new ApiError(422, `${key} must be a string`)
	return input[key]
}

export function boolField(input: Record<string, unknown>, key: string, fallback = false): boolean {
	const value = input[key]
	if (value === undefined || value === null) return fallback
	if (value === true || value === 'true' || value === '1') return true
	if (value === false || value === 'false' || value === '0') return false
	throw new ApiError(422, `${key} must be a boolean`)
}

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
	)
}

export function sameOrigin(request: Request, origin: string): void {
	if (request.headers.get('origin') !== origin) throw new ApiError(403, 'Invalid request origin')
}

export async function throttle(c: Context<AppEnv>, key: string): Promise<void> {
	if (c.env.AUTH_LIMITER && !(await c.env.AUTH_LIMITER.limit({ key })).success) {
		c.header('Retry-After', '60')
		throw new ApiError(429, 'Try again in a minute')
	}
}
