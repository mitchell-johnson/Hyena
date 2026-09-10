import {
	MP3,
	MP4,
	CustomSource,
	Input,
	Output,
	BufferTarget,
	Mp3OutputFormat,
	EncodedPacketSink,
	EncodedAudioPacketSource,
} from 'mediabunny'
import { ApiError } from '../http'
import type { Env, MediaRow } from '../types'
import { storeStream } from './storage'
import { charge } from '../budgets'

export const MAX_DURATION = 60
export const MEDIA_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/heic',
	'video/mp4',
	'audio/mpeg',
]
export const maxMediaBytes = (env: Env) => Math.min(40_000_000, Math.max(1, Number(env.MAX_MEDIA_BYTES) || 40_000_000))

async function mediaInput(env: Env, media: MediaRow) {
	let readCount = 0,
		readBytes = 0
	const object = await env.MEDIA_BUCKET.head(media.original_key)
	if (!object) throw new ApiError(422, 'The original media is missing')
	const input = new Input({
		formats: media.media_type === 'video' ? [MP4] : [MP3],
		source: new CustomSource({
			getSize: () => object.size,
			read: async (start, end) => {
				if (++readCount > 256 || (readBytes += end - start) > 80_000_000)
					throw new ApiError(422, 'Media metadata exceeds the parsing budget')
				const part = await env.MEDIA_BUCKET.get(media.original_key, { range: { offset: start, length: end - start } })
				if (!part) throw new ApiError(422, 'Media disappeared while being read')
				return part.body
			},
			maxCacheSize: 1024 * 1024,
		}),
	})
	return input
}
export async function probeMedia(env: Env, media: MediaRow) {
	const input = await mediaInput(env, media)
	try {
		const duration = await input.computeDuration()
		if (!Number.isFinite(duration) || duration <= 0 || duration >= MAX_DURATION)
			throw new ApiError(422, 'Audio and video must be shorter than 60 seconds')
		const video = await input.getPrimaryVideoTrack(),
			audio = await input.getPrimaryAudioTrack()
		if (media.media_type === 'video') {
			if (!video || (await video.getCodec()) !== 'avc' || (audio && (await audio.getCodec()) !== 'aac'))
				throw new ApiError(415, 'Use H.264 MP4 video with optional AAC audio')
			const width = await video.getDisplayWidth(),
				height = await video.getDisplayHeight()
			if (width * height > 1920 * 1080 || !width || !height) throw new ApiError(422, 'Video resolution exceeds 1080p')
			const stats = await video.computePacketStats()
			if (!Number.isFinite(stats.averagePacketRate) || stats.averagePacketRate > 60.01)
				throw new ApiError(422, 'Video frame rate exceeds 60 FPS')
			return {
				duration,
				width,
				height,
				size: `${width}x${height}`,
				aspect: width / height,
				frame_rate: String(stats.averagePacketRate),
			}
		}
		if (video || !audio || (await audio.getCodec()) !== 'mp3') throw new ApiError(415, 'Use MP3 audio')
		return { duration, sample_rate: await audio.getSampleRate(), channels: await audio.getNumberOfChannels() }
	} catch (error) {
		if (error instanceof ApiError) throw error
		// Unrecognized/truncated input is a user error, not an endless retry loop.
		throw new ApiError(422, 'Unable to parse this media file')
	} finally {
		input.dispose()
	}
}

export function animationInfo(bytes: Uint8Array): { frames: number; duration: number; pixels: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		text = (start: number, n: number) => String.fromCharCode(...bytes.subarray(start, start + n))
	if (text(0, 3) === 'GIF') {
		if (bytes.length < 13) throw new ApiError(422, 'Truncated GIF')
		let pos = 13 + (bytes[10]! & 128 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0),
			frames = 0,
			duration = 0,
			pixels = 0,
			delay = 0.1
		const subblocks = () => {
			while (pos < bytes.length) {
				const n = bytes[pos++]!
				if (!n) return
				pos += n
				if (pos > bytes.length) throw new ApiError(422, 'Truncated GIF block')
			}
			throw new ApiError(422, 'Truncated GIF')
		}
		while (pos < bytes.length) {
			const tag = bytes[pos++]!
			if (tag === 0x3b) return { frames, duration, pixels }
			if (tag === 0x21) {
				const label = bytes[pos++]!
				if (label === 0xf9) {
					if (pos + 6 > bytes.length || bytes[pos] !== 4) throw new ApiError(422, 'Invalid GIF control')
					const cs = view.getUint16(pos + 2, true)
					delay = cs < 2 ? 0.1 : cs / 100
				}
				subblocks()
			} else if (tag === 0x2c) {
				if (pos + 9 > bytes.length) throw new ApiError(422, 'Truncated GIF frame')
				const width = view.getUint16(pos + 4, true),
					height = view.getUint16(pos + 6, true),
					packed = bytes[pos + 8]!
				pos += 9
				if (packed & 128) pos += 3 * 2 ** ((packed & 7) + 1)
				pos++
				subblocks()
				frames++
				duration += delay
				pixels += width * height
				if (frames > 10000 || pixels > 50_000_000 || duration >= 60)
					throw new ApiError(422, 'Animation exceeds 50 megapixels or must be shorter than 60 seconds')
			} else throw new ApiError(422, 'Invalid GIF block')
		}
		throw new ApiError(422, 'GIF trailer missing')
	}
	if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
		let duration = 0,
			frames = 0,
			pixels = 0
		for (let p = 12; p + 8 <= bytes.length;) {
			const size = view.getUint32(p + 4, true)
			if (p + 8 + size > bytes.length) throw new ApiError(422, 'Truncated WebP')
			if (text(p, 4) === 'ANMF') {
				if (size < 16) throw new ApiError(422, 'Invalid WebP frame')
				const u24 = (i: number) => bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16)
				duration += Math.max(10, u24(p + 20)) / 1000
				pixels += (u24(p + 14) + 1) * (u24(p + 17) + 1)
				frames++
			}
			p += 8 + size + (size % 2)
		}
		if (frames) return { duration, frames, pixels }
	}
	if (text(1, 3) === 'PNG') {
		let frames = 0,
			duration = 0,
			pixels = 0
		for (let p = 8; p + 12 <= bytes.length;) {
			const size = view.getUint32(p)
			if (p + 12 + size > bytes.length) throw new ApiError(422, 'Truncated PNG')
			if (text(p + 4, 4) === 'fcTL') {
				if (size !== 26) throw new ApiError(422, 'Invalid PNG frame')
				frames++
				pixels += view.getUint32(p + 12) * view.getUint32(p + 16)
				duration += Math.max(0.01, view.getUint16(p + 28) / (view.getUint16(p + 30) || 100))
			}
			p += size + 12
		}
		if (frames) return { duration, frames, pixels }
	}
	return null
}

async function source(env: Env, key: string) {
	const object = await env.MEDIA_BUCKET.get(key)
	if (!object) throw new ApiError(422, 'The original media is missing')
	return object.body
}

export async function customThumbnail(env: Env, media: MediaRow, body: ReadableStream<Uint8Array>, mutation: string) {
	await charge(env, 'thumbnail:' + media.id + ':' + mutation, 'image_transforms', 1)
	const output = await env.IMAGES.input(body)
			.transform({ width: 400, height: 400, fit: 'scale-down' })
			.output({ format: 'image/webp' }),
		response = output.response()
	if (!response.ok || !response.body) throw new Error('Thumbnail processing failed')
	const key = `public/${media.original_key.split('/')[1]}/preview.webp`
	await storeStream(env.MEDIA_BUCKET, key, response.body, 'image/webp', 2_000_000)
	return key
}

export async function processMedia(env: Env, id: string) {
	const media = await env.DB.prepare('SELECT * FROM media_attachments WHERE id=?').bind(id).first<MediaRow>()
	if (!media || media.state === 'ready' || media.state === 'failed') return
	await env.DB.prepare("UPDATE media_attachments SET state='processing',updated_at=? WHERE id=?")
		.bind(Date.now(), id)
		.run()
	// Capabilities are random and unguessable; originals never have a public URL.
	const base = `public/${media.original_key.split('/')[1]}`
	let output: string,
		preview: string | null = null,
		metadata: Record<string, unknown>
	await charge(env, 'bytes:' + id, 'media_bytes', media.bytes)
	if (media.media_type === 'image') {
		await charge(env, 'image:' + id, 'image_transforms', 2)
		if (media.bytes > 20_000_000) throw new ApiError(413, 'Images must be at most 20 MB')
		if (['image/gif', 'image/webp', 'image/png'].includes(media.mime_type)) {
			const file = await env.MEDIA_BUCKET.get(media.original_key)
			if (!file) throw new ApiError(422, 'Image is missing')
			const animation = animationInfo(new Uint8Array(await file.arrayBuffer()))
			if (animation && (animation.duration >= 60 || animation.pixels > 50_000_000))
				throw new ApiError(422, 'Animation exceeds 50 megapixels or must be shorter than 60 seconds')
		}
		const info = await env.IMAGES.info(await source(env, media.original_key))
		if (
			![
				'image/jpeg',
				'image/png',
				'image/webp',
				'image/gif',
				'image/heic',
				'jpeg',
				'png',
				'webp',
				'gif',
				'heic',
			].includes(info.format) ||
			!info.width ||
			!info.height ||
			info.width * info.height > 40_000_000
		)
			throw new ApiError(422, 'Invalid image or image larger than 40 megapixels')
		const scale = Math.min(1, 2048 / Math.max(info.width, info.height))
		const width = Math.max(1, Math.round(info.width * scale)),
			height = Math.max(1, Math.round(info.height * scale))
		const main = await env.IMAGES.input(await source(env, media.original_key))
			.transform({ width, height, fit: 'scale-down' })
			.output({ format: 'image/webp' })
		const thumb = await env.IMAGES.input(await source(env, media.original_key))
			.transform({ width: 400, height: 400, fit: 'scale-down' })
			.output({ format: 'image/webp' })
		output = `${base}/image.webp`
		preview = `${base}/preview.webp`
		const response = main.response(),
			thumbnail = thumb.response()
		if (!response.ok || !response.body || !thumbnail.ok || !thumbnail.body)
			throw new Error('Image transformation failed')
		await storeStream(env.MEDIA_BUCKET, output, response.body, 'image/webp', maxMediaBytes(env))
		await storeStream(env.MEDIA_BUCKET, preview, thumbnail.body, 'image/webp', maxMediaBytes(env))
		const thumbScale = Math.min(1, 400 / Math.max(info.width, info.height))
		metadata = {
			original: { width, height, size: `${width}x${height}`, aspect: width / height },
			small: { width: Math.round(info.width * thumbScale), height: Math.round(info.height * thumbScale) },
		}
	} else {
		const details = await probeMedia(env, media)
		if (media.media_type === 'video') {
			await charge(env, 'video:' + id, 'media_seconds', Math.ceil(details.duration) + 1)
			output = `${base}/video.mp4`
			preview = `${base}/preview.jpg`
			const video = await env.MEDIA.input(await source(env, media.original_key))
				.output({ mode: 'video', duration: '60s' })
				.response()
			if (!video.ok || !video.body) throw new Error('Video transformation failed')
			await storeStream(env.MEDIA_BUCKET, output, video.body, 'video/mp4', maxMediaBytes(env))
			const frame = await env.MEDIA.input(await source(env, media.original_key))
				.output({ mode: 'frame', time: '0s', format: 'jpg' })
				.response()
			if (!frame.ok || !frame.body) throw new Error('Video poster transformation failed')
			await storeStream(env.MEDIA_BUCKET, preview, frame.body, 'image/jpeg', maxMediaBytes(env))
		} else {
			// Remux encoded MP3 frames without decoding or retaining source tags.
			// Under a minute of MP3 is small; the source's large ID3 blocks stay in R2.
			output = `${base}/audio.mp3`
			const input = await mediaInput(env, media),
				track = await input.getPrimaryAudioTrack()
			if (!track) throw new ApiError(422, 'Audio track missing')
			const target = new BufferTarget(),
				muxer = new Output({ format: new Mp3OutputFormat(), target }),
				packets = new EncodedAudioPacketSource('mp3')
			muxer.addAudioTrack(packets)
			try {
				await muxer.start()
				const config = await track.getDecoderConfig()
				for await (const packet of new EncodedPacketSink(track).packets())
					await packets.add(packet, config ? { decoderConfig: config } : undefined)
				await muxer.finalize()
				if (!target.buffer) throw new Error('Audio remux failed')
				await env.MEDIA_BUCKET.put(output, target.buffer, { httpMetadata: { contentType: 'audio/mpeg' } })
			} finally {
				input.dispose()
			}
		}
		metadata = { original: details }
	}
	if (media.custom_preview_key)
		preview = await customThumbnail(env, media, await source(env, media.custom_preview_key), 'upload')
	await env.DB.prepare(
		`UPDATE media_attachments SET state='ready',output_key=?,preview_key=?,metadata=?,mime_type=?,error=NULL,updated_at=? WHERE id=?`
	)
		.bind(
			output,
			preview,
			JSON.stringify(metadata),
			media.media_type === 'image' ? 'image/webp' : media.media_type === 'video' ? 'video/mp4' : 'audio/mpeg',
			Date.now(),
			id
		)
		.run()
	// The processed output is authoritative; keeping originals doubles storage.
	await env.MEDIA_BUCKET.delete([media.original_key, ...(media.custom_preview_key ? [media.custom_preview_key] : [])])
}
