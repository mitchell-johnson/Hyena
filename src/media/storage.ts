import { ApiError } from '../http'

// R2 multipart upload gives each part a known length and keeps memory bounded
// even when a client or transformation response uses chunked transfer encoding.
export async function storeStream(
	bucket: R2Bucket,
	key: string,
	stream: ReadableStream<Uint8Array>,
	contentType: string,
	maximum: number
) {
	const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } })
	const reader = stream.getReader(),
		parts: R2UploadedPart[] = []
	const buffer = new Uint8Array(5 * 1024 * 1024)
	let filled = 0,
		total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (total > maximum) throw new ApiError(413, 'Media exceeds the byte limit')
			let offset = 0
			while (offset < value.length) {
				const length = Math.min(buffer.length - filled, value.length - offset)
				buffer.set(value.subarray(offset, offset + length), filled)
				offset += length
				filled += length
				if (filled === buffer.length) {
					parts.push(await upload.uploadPart(parts.length + 1, buffer))
					filled = 0
				}
			}
		}
		if (!total) throw new ApiError(422, 'The media file is empty')
		if (filled) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)))
		await upload.complete(parts)
		return total
	} catch (error) {
		await reader.cancel().catch(() => {})
		await upload.abort().catch(() => {})
		throw error
	} finally {
		reader.releaseLock()
	}
}
