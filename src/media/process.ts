import { MP3, MP4, CustomSource, Input } from 'mediabunny'
import { ApiError } from '../http'
import type { Env, MediaRow } from '../types'
import { storeStream } from './storage'

export const MAX_DURATION = 60
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/mpeg']
export const maxMediaBytes = (env: Env) => Math.min(40_000_000, Math.max(1, Number(env.MAX_MEDIA_BYTES) || 40_000_000))

export async function probeMedia(env: Env, media: MediaRow) {
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
	try {
		const duration = await input.computeDuration()
		if (!Number.isFinite(duration) || duration <= 0 || duration >= MAX_DURATION)
			throw new ApiError(422, 'Audio and video must be shorter than 60 seconds')
		const video = await input.getPrimaryVideoTrack(),
			audio = await input.getPrimaryAudioTrack()
		if (media.media_type === 'video') {
			if (!video || (await video.getCodec()) !== 'avc' || (audio && (await audio.getCodec()) !== 'aac'))
				throw new ApiError(415, 'This milestone accepts H.264 MP4 video with optional AAC audio')
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
		if (video || !audio || (await audio.getCodec()) !== 'mp3')
			throw new ApiError(415, 'This milestone accepts MP3 audio')
		return { duration, sample_rate: await audio.getSampleRate(), channels: await audio.getNumberOfChannels() }
	} catch (error) {
		if (error instanceof ApiError) throw error
		// Unrecognized/truncated input is a user error, not an endless retry loop.
		throw new ApiError(422, 'Unable to parse this media file')
	} finally {
		input.dispose()
	}
}

async function source(env: Env, key: string) {
	const object = await env.MEDIA_BUCKET.get(key)
	if (!object) throw new ApiError(422, 'The original media is missing')
	return object.body
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
	if (media.media_type === 'image') {
		const info = await env.IMAGES.info(await source(env, media.original_key))
		if (
			!['image/jpeg', 'image/png', 'image/webp', 'jpeg', 'png', 'webp'].includes(info.format) ||
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
			// MP3 pass-through avoids a paid transcode. Embedded tags are preserved;
			// the uploader must remove sensitive tags before upload (see README).
			output = `${base}/audio.mp3`
			await storeStream(
				env.MEDIA_BUCKET,
				output,
				await source(env, media.original_key),
				'audio/mpeg',
				maxMediaBytes(env)
			)
		}
		metadata = { original: details }
	}
	await env.DB.prepare(
		`UPDATE media_attachments SET state='ready',output_key=?,preview_key=?,metadata=?,error=NULL,updated_at=? WHERE id=?`
	)
		.bind(output, preview, JSON.stringify(metadata), Date.now(), id)
		.run()
	// The processed output is authoritative; keeping originals doubles storage.
	await env.MEDIA_BUCKET.delete(media.original_key)
}
