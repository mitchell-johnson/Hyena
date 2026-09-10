import { expirePoll } from './poll-expiry'
import type { Env, JobMessage, JobRow, StatusRow } from './types'
import { one, parsed, run } from './data'
import { unseal } from './federation/keys'
import { ApiError } from './http'
import { processMedia } from './media/process'
import { statusEvent } from './events'
import { federationMessage, sendStored, accountEvent } from './federation'
import { publishScheduled } from './status-actions'
import { deliverPush } from './push'
import { sendEmail } from './profile'
import { receiveExtension } from './federation/consent'
import { fetchCard } from './community'
import { processImport, processExport } from './lifecycle'

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
		`UPDATE jobs SET state='processing',lease_token=?,lease_until=?,attempt=attempt+1,first_attempt_at=COALESCE(first_attempt_at,?)
    WHERE id=? AND available_at <= ? AND (state IN ('pending','queued') OR (state='processing' AND lease_until < ?)) RETURNING *`
	)
		.bind(lease, now + 300_000, now, id, now, now)
		.first<JobRow>()
	if (!job) return
	// A long Retry-After wakes at the delivery deadline only to expire the
	// task. Do not send earlier than requested or hold later ordered work forever.
	if (job.kind === 'federation.message' && now - (job.first_attempt_at ?? now) >= 7 * 86400000) {
		await run(
			env,
			"UPDATE jobs SET state='dead',lease_token=NULL,lease_until=NULL,dispatch_until=NULL,last_error='Remote delivery retry limit reached' WHERE id=? AND lease_token=?",
			id,
			lease
		)
		return
	}
	const raw = parsed<Record<string, unknown>>(job.payload, {}),
		message = raw.message as { type?: string; activity?: Record<string, unknown> } | undefined
	const order =
		typeof raw.orderingKey === 'string'
			? raw.orderingKey
			: raw.importId
				? 'import:' + raw.importId
				: raw.exportId
					? 'export:' + raw.exportId
					: job.kind === 'status.event'
						? 'status:' + raw.statusId
						: job.kind === 'federation.extension'
							? 'inbox:' + raw.actorId
							: null
	if (order) {
		const earlier = await one(
			env,
			"SELECT 1 FROM jobs WHERE id<>? AND state NOT IN ('done','dead') AND json_extract(payload,'$.orderingKey')=? AND rowid<(SELECT rowid FROM jobs WHERE id=?) LIMIT 1",
			id,
			order,
			id
		)
		const lock = earlier
			? null
			: await env.DB.prepare(
					'INSERT INTO job_locks VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET job_id=excluded.job_id,lease_token=excluded.lease_token,lease_until=excluded.lease_until WHERE job_locks.lease_until<? RETURNING key'
				)
					.bind(order, id, lease, Date.now() + 300000, Date.now())
					.first()
		if (!lock) {
			await run(
				env,
				"UPDATE jobs SET state='pending',available_at=?,lease_token=NULL,lease_until=NULL,attempt=attempt-1 WHERE id=? AND lease_token=?",
				Date.now() + 30000,
				id,
				lease
			)
			return
		}
	}
	const heartbeat = setInterval(() => {
		void env.DB.batch([
			env.DB.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND lease_token=? AND state='processing'").bind(
				Date.now() + 300000,
				id,
				lease
			),
			env.DB.prepare('UPDATE job_locks SET lease_until=? WHERE job_id=? AND lease_token=?').bind(
				Date.now() + 300000,
				id,
				lease
			),
		]).catch(() => {})
	}, 60000)
	try {
		const payload = JSON.parse(job.payload) as {
			mediaId?: string
			pollId?: string
			statusId?: string
			event?: string
			scheduleId?: string
			notificationId?: string
			message: import('@fedify/fedify').Message
			messageCipher?: string
			actorId: string
			accountId?: string
			importId?: string
			exportId?: string
			activity: Record<string, unknown>
			recipients: string[]
		}
		if (job.kind === 'poll.close' && payload.pollId) await expirePoll(env, payload.pollId)
		else if (job.kind === 'media.process' && payload.mediaId) await processMedia(env, payload.mediaId)
		else if (job.kind === 'status.event' && payload.statusId) {
			const status = await env.DB.prepare('SELECT * FROM statuses WHERE id=?').bind(payload.statusId).first<StatusRow>()
			if (status) await statusEvent(env, status)
		} else if (job.kind === 'federation.message')
			await federationMessage(
				env,
				{
					message: payload.messageCipher
						? await unseal<import('@fedify/fedify').Message>(env, payload.messageCipher)
						: payload.message,
				},
				{ id, token: lease }
			)
		else if (job.kind === 'federation.extension') await receiveExtension(env, payload)
		else if (job.kind === 'card.fetch' && payload.statusId) await fetchCard(env, payload.statusId)
		else if (job.kind === 'federation.send') await sendStored(env, payload)
		else if (job.kind === 'schedule.publish' && payload.scheduleId) await publishScheduled(env, payload.scheduleId)
		else if (job.kind === 'notification.push' && payload.notificationId) await deliverPush(env, payload.notificationId)
		else if (job.kind === 'account.import' && payload.importId) await processImport(env, payload.importId)
		else if (job.kind === 'account.export' && payload.exportId) await processExport(env, payload.exportId)
		else if (job.kind === 'account.event' && payload.accountId) await accountEvent(env, payload.accountId, job.id)
		else if (job.kind === 'email.send') await sendEmail(env, JSON.parse(job.payload))
		else throw new ApiError(422, 'Invalid durable job payload')
		await env.DB.prepare(
			`UPDATE jobs SET state='done',completed_at=?,lease_token=NULL,lease_until=NULL,dispatch_until=NULL,last_error=NULL WHERE id=? AND lease_token=?`
		)
			.bind(Date.now(), id, lease)
			.run()
	} catch (error) {
		const terminal =
			(error instanceof ApiError && [400, 401, 403, 404, 410, 413, 415, 422].includes(error.status)) ||
			Date.now() - (job.first_attempt_at ?? now) >= 7 * 86400000 ||
			job.attempt >= 100
		const reason = error instanceof ApiError ? error.message : 'Processing failed; inspect provider health and retry'
		const failure = env.DB.prepare(
			`UPDATE jobs SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,dispatch_until=NULL,last_error=? WHERE id=? AND lease_token=?`
		).bind(
			terminal ? 'dead' : 'pending',
			Date.now() +
				Math.floor(Math.min(6 * 3600_000, 5000 * 2 ** Math.min(job.attempt, 20)) * (0.8 + Math.random() * 0.4)),
			reason,
			id,
			lease
		)
		if (terminal && job.kind === 'media.process') {
			const payload = parsed<{ mediaId: string | null }>(job.payload, { mediaId: null })
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE media_attachments SET state='failed',error=?,updated_at=? WHERE id=? AND state <> 'ready' AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=?)`
				).bind(reason, Date.now(), payload.mediaId, id, lease),
				failure,
			])
		} else await failure.run()
	} finally {
		clearInterval(heartbeat)
		if (order) await run(env, 'DELETE FROM job_locks WHERE job_id=? AND lease_token=?', id, lease)
	}
}

export async function consume(batch: MessageBatch<JobMessage>, env: Env) {
	if (env.MAINTENANCE_MODE === 'true') {
		for (const message of batch.messages) message.retry({ delaySeconds: 300 })
		return
	}
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
	if (env.MAINTENANCE_MODE === 'true') return
	await publishDue(env)
	for (const p of (
		await env.DB.prepare('SELECT id FROM polls WHERE notified_at IS NULL AND expires_at<=? LIMIT 10')
			.bind(new Date().toISOString())
			.all<{ id: string }>()
	).results)
		await expirePoll(env, p.id)
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
	await env.DB.batch(
		['security_challenges', 'email_tokens', 'federation_kv'].map((table) =>
			env.DB.prepare(
				`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at IS NOT NULL AND expires_at<? LIMIT 100)`
			).bind(now)
		)
	)
	const expired = await env.DB.prepare('SELECT id,account_id FROM account_exports WHERE expires_at<? LIMIT 1')
		.bind(new Date(now).toISOString())
		.first<{ id: string; account_id: string }>()
	if (expired) {
		const list = await env.MEDIA_BUCKET.list({ prefix: `exports/${expired.account_id}/${expired.id}/`, limit: 100 })
		if (list.objects.length) await env.MEDIA_BUCKET.delete(list.objects.map((o) => o.key))
		if (!list.truncated) await run(env, 'DELETE FROM account_exports WHERE id=?', expired.id)
	}
	const abandoned = await env.DB.prepare(
		`SELECT id,original_key,output_key,preview_key,custom_preview_key FROM media_attachments WHERE status_id IS NULL AND scheduled_id IS NULL AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.avatar_media_id=media_attachments.id OR a.header_media_id=media_attachments.id) AND NOT EXISTS(SELECT 1 FROM custom_emojis e WHERE e.url LIKE '%'||replace(media_attachments.output_key,'public/','')) AND state <> 'processing' AND updated_at < ? LIMIT 20`
	)
		.bind(now - 7 * 86_400_000)
		.all<{
			id: string
			original_key: string
			output_key: string | null
			preview_key: string | null
			custom_preview_key: string | null
		}>()
	for (const media of abandoned.results) {
		// Claim before deleting objects so a simultaneous post cannot attach it.
		const claim = await env.DB.prepare(
			`UPDATE media_attachments SET state='failed',error='Upload expired' WHERE id=? AND status_id IS NULL AND scheduled_id IS NULL AND state<>'processing' AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.avatar_media_id=media_attachments.id OR a.header_media_id=media_attachments.id) AND NOT EXISTS(SELECT 1 FROM custom_emojis e WHERE e.url LIKE '%'||replace(media_attachments.output_key,'public/','')) AND updated_at < ?`
		)
			.bind(media.id, now - 7 * 86_400_000)
			.run()
		if (!claim.meta.changes) continue
		const base = `public/${media.original_key.split('/')[1]}`
		await env.MEDIA_BUCKET.delete([
			...new Set(
				[
					media.original_key,
					media.output_key,
					media.preview_key,
					media.custom_preview_key,
					...['image.webp', 'preview.webp', 'video.mp4', 'preview.jpg', 'audio.mp3'].map((v) => `${base}/${v}`),
				].filter((k): k is string => !!k)
			),
		])
		await env.DB.prepare('DELETE FROM media_attachments WHERE id=? AND status_id IS NULL').bind(media.id).run()
	}
}
