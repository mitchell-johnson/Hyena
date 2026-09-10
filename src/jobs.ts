import type { Env, JobMessage, JobRow, StatusRow } from './types'
import { ApiError } from './http'
import { processMedia } from './media/process'
import { statusJSON } from './serializers'

export function jobStatement(
	env: Env,
	id: string,
	kind: JobRow['kind'],
	payload: unknown,
	guard?: { id: string; mutation: string }
) {
	const now = Date.now()
	return guard
		? env.DB.prepare(
				`INSERT INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM statuses WHERE id=? AND mutation_id=?)`
			).bind(id, kind, JSON.stringify(payload), now, now, guard.id, guard.mutation)
		: env.DB.prepare('INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,?,?,?,?)').bind(
				id,
				kind,
				JSON.stringify(payload),
				now,
				now
			)
}

// D1 is authoritative. Queue delivery is an accelerator and may duplicate or
// expire; the sweep can recover both a missed send and an expired delivery.
export async function publishDue(env: Env, limit = 20) {
	const now = Date.now()
	const jobs = await env.DB.prepare(
		`SELECT id FROM jobs WHERE available_at <= ? AND state IN ('pending','queued','processing')
    AND (state='pending' OR (state='queued' AND queued_at < ?) OR (state='processing' AND lease_until < ?))
    AND (dispatch_until IS NULL OR dispatch_until < ?) ORDER BY available_at LIMIT ?`
	)
		.bind(now, now - 300_000, now, now, limit)
		.all<{ id: string }>()
	for (const job of jobs.results) {
		const claim = await env.DB.prepare(
			`UPDATE jobs SET dispatch_until=? WHERE id=? AND state NOT IN ('done','dead') AND (dispatch_until IS NULL OR dispatch_until < ?)`
		)
			.bind(now + 60_000, job.id, now)
			.run()
		if (!claim.meta.changes) continue
		try {
			await env.JOBS.send({ version: 1, id: job.id })
			await env.DB.prepare(
				`UPDATE jobs SET state='queued',queued_at=?,dispatch_until=NULL WHERE id=? AND (state IN ('pending','queued') OR (state='processing' AND lease_until < ?))`
			)
				.bind(now, job.id, now)
				.run()
		} catch {
			await env.DB.prepare('UPDATE jobs SET dispatch_until=NULL WHERE id=?').bind(job.id).run()
			// Persisted intent remains available to the next sweep.
		}
	}
}

export async function executeJob(env: Env, id: string) {
	const now = Date.now(),
		lease = crypto.randomUUID()
	const job = await env.DB.prepare(
		`UPDATE jobs SET state='processing',lease_token=?,lease_until=?,attempt=attempt+1
    WHERE id=? AND available_at <= ? AND (state IN ('pending','queued') OR (state='processing' AND lease_until < ?)) RETURNING *`
	)
		.bind(lease, now + 300_000, id, now, now)
		.first<JobRow>()
	if (!job) return
	try {
		const payload = JSON.parse(job.payload) as { mediaId?: string; statusId?: string; event?: string }
		if (job.kind === 'media.process' && payload.mediaId) await processMedia(env, payload.mediaId)
		else if (job.kind === 'status.event' && payload.statusId) {
			const status = await env.DB.prepare('SELECT * FROM statuses WHERE id=?').bind(payload.statusId).first<StatusRow>()
			if (status)
				await env.STREAMS.get(env.STREAMS.idFromName(status.account_id)).publish({
					id: status.id,
					revision: status.revision,
					event: status.deleted_at ? 'delete' : status.revision > 1 ? 'status.update' : 'update',
					payload: status.deleted_at ? status.id : JSON.stringify(await statusJSON(env, status, status.account_id)),
					public: !status.deleted_at && status.visibility === 'public',
				})
		} else throw new ApiError(422, 'Invalid durable job payload')
		await env.DB.prepare(
			`UPDATE jobs SET state='done',completed_at=?,lease_token=NULL,lease_until=NULL,dispatch_until=NULL WHERE id=? AND lease_token=?`
		)
			.bind(Date.now(), id, lease)
			.run()
	} catch (error) {
		const terminal = (error instanceof ApiError && [400, 413, 415, 422].includes(error.status)) || job.attempt >= 8
		const reason = error instanceof ApiError ? error.message : 'Processing failed; inspect provider health and retry'
		const failure = env.DB.prepare(
			`UPDATE jobs SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,dispatch_until=NULL,last_error=? WHERE id=? AND lease_token=?`
		).bind(terminal ? 'dead' : 'pending', Date.now() + Math.min(3600_000, 5000 * 2 ** job.attempt), reason, id, lease)
		if (terminal && job.kind === 'media.process') {
			const payload = JSON.parse(job.payload) as { mediaId: string }
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE media_attachments SET state='failed',error=?,updated_at=? WHERE id=? AND state <> 'ready' AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=?)`
				).bind(reason, Date.now(), payload.mediaId, id, lease),
				failure,
			])
		} else await failure.run()
	}
}

export async function consume(batch: MessageBatch<JobMessage>, env: Env) {
	for (const message of batch.messages) {
		if (message.body?.version !== 1 || typeof message.body.id !== 'string' || message.body.id.length > 128) {
			message.retry()
			continue
		}
		try {
			await executeJob(env, message.body.id)
			message.ack()
		} catch {
			message.retry()
		}
	}
}

export async function sweep(env: Env) {
	await publishDue(env)
	const now = Date.now()
	await env.DB.batch([
		env.DB.prepare(
			'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < ? LIMIT 100)'
		).bind(now),
		env.DB.prepare(
			'DELETE FROM oauth_codes WHERE code_hash IN (SELECT code_hash FROM oauth_codes WHERE expires_at < ? LIMIT 100)'
		).bind(now - 86_400_000),
		env.DB.prepare(
			`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE state='done' AND completed_at < ? LIMIT 100)`
		).bind(now - 7 * 86_400_000),
	])
	const abandoned = await env.DB.prepare(
		`SELECT id,original_key,output_key,preview_key FROM media_attachments WHERE status_id IS NULL AND state <> 'processing' AND updated_at < ? LIMIT 20`
	)
		.bind(now - 7 * 86_400_000)
		.all<{ id: string; original_key: string; output_key: string | null; preview_key: string | null }>()
	for (const media of abandoned.results) {
		// Claim before deleting objects so a simultaneous post cannot attach it.
		const claim = await env.DB.prepare(
			`UPDATE media_attachments SET state='failed',error='Upload expired' WHERE id=? AND status_id IS NULL AND updated_at < ?`
		)
			.bind(media.id, now - 7 * 86_400_000)
			.run()
		if (!claim.meta.changes) continue
		const base = `public/${media.original_key.split('/')[1]}`
		await env.MEDIA_BUCKET.delete([
			media.original_key,
			...['image.webp', 'preview.webp', 'video.mp4', 'preview.jpg', 'audio.mp3'].map((v) => `${base}/${v}`),
		])
		await env.DB.prepare('DELETE FROM media_attachments WHERE id=? AND status_id IS NULL').bind(media.id).run()
	}
}
