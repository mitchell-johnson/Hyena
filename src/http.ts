import type { Context } from 'hono'
import type { AppEnv } from './types'

export class ApiError extends Error {
	constructor(
		public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 501 | 503,
		message: string,
		public code?: string
	) {
		super(message)
	}
}

export async function readInput(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
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
	const type = request.headers.get('content-type')?.split(';')[0]
	if (type === 'application/json') {
		try {
			const result: unknown = JSON.parse(text)
			if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>
		} catch {
			/* Produce the same bounded client error for invalid JSON. */
		}
		throw new ApiError(400, 'Expected a JSON object')
	}
	if (type !== 'application/x-www-form-urlencoded') throw new ApiError(415, 'Use JSON or form-urlencoded input')
	const result: Record<string, unknown> = Object.create(null)
	for (const [key, value] of new URLSearchParams(text)) {
		if (key.endsWith('[]')) {
			const name = key.slice(0, -2)
			const values = result[name]
			if (values !== undefined && !Array.isArray(values)) throw new ApiError(400, 'Conflicting form fields')
			result[name] = [...((values as string[] | undefined) ?? []), value]
		} else {
			if (result[key] !== undefined) throw new ApiError(400, 'Duplicate form field')
			result[key] = value
		}
	}
	return result
}

export function stringField(input: Record<string, unknown>, key: string, fallback = ''): string {
	if (input[key] === undefined) return fallback
	if (typeof input[key] !== 'string') throw new ApiError(422, `${key} must be a string`)
	return input[key]
}

export function boolField(input: Record<string, unknown>, key: string, fallback = false): boolean {
	const value = input[key]
	if (value === undefined) return fallback
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
