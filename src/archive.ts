import type { Env } from './types'
import { ApiError } from './http'
const encoder = new TextEncoder()
function write(bytes: Uint8Array, offset: number, length: number, value: string) {
	const text = encoder.encode(value)
	if (text.length > length) throw new ApiError(422, 'Archive path is too long')
	bytes.set(text, offset)
}
export function tarHeader(name: string, size: number, modified: number) {
	if (name.startsWith('/') || name.split('/').includes('..') || !Number.isSafeInteger(size) || size < 0)
		throw new ApiError(422, 'Invalid archive entry')
	const header = new Uint8Array(512)
	let path = name,
		prefix = ''
	if (encoder.encode(name).length > 100) {
		const at = name.lastIndexOf('/')
		prefix = name.slice(0, at)
		path = name.slice(at + 1)
	}
	write(header, 0, 100, path)
	write(header, 100, 8, '0000600\0')
	write(header, 108, 8, '0000000\0')
	write(header, 116, 8, '0000000\0')
	write(header, 124, 12, size.toString(8).padStart(11, '0') + '\0')
	write(
		header,
		136,
		12,
		Math.floor(modified / 1000)
			.toString(8)
			.padStart(11, '0') + '\0'
	)
	write(header, 148, 8, '        ')
	write(header, 156, 1, '0')
	write(header, 257, 6, 'ustar\0')
	write(header, 263, 2, '00')
	write(header, 345, 155, prefix)
	const sum = header.reduce((n, b) => n + b, 0)
	write(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
	return header
}
export function archiveStream(env: Env, prefix: string) {
	async function* entries() {
		let cursor: string | undefined
		do {
			const page = await env.MEDIA_BUCKET.list({ prefix, limit: 100, cursor })
			for (const object of page.objects) {
				const data = await env.MEDIA_BUCKET.get(object.key)
				if (!data) throw new ApiError(409, 'An archive file expired during download')
				yield tarHeader(object.key.slice(prefix.length), data.size, +data.uploaded)
				const reader = data.body.getReader()
				try {
					for (;;) {
						const part = await reader.read()
						if (part.done) break
						yield part.value
					}
				} finally {
					await reader.cancel()
					reader.releaseLock()
				}
				const pad = (512 - (data.size % 512)) % 512
				if (pad) yield new Uint8Array(pad)
			}
			cursor = page.truncated ? page.cursor : undefined
		} while (cursor)
		yield new Uint8Array(1024)
	}
	const iterator = entries()
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next()
				if (next.done) controller.close()
				else controller.enqueue(next.value)
			} catch (error) {
				controller.error(error)
			}
		},
		async cancel() {
			await iterator.return()
		},
	})
}
