import { all, one, now } from './data'
import { notificationStatements } from './notifications'
import type { Env, StatusRow } from './types'
export async function expirePoll(env: Env, id: string) {
	const p = await one<{ id: string; status_id: string; expires_at: string; notified_at: string | null }>(
		env,
		'SELECT * FROM polls WHERE id=?',
		id
	)
	if (!p || p.notified_at || Date.parse(p.expires_at) > Date.now()) return
	const s = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=? AND deleted_at IS NULL', p.status_id)
	if (!s) return
	const marker = now(),
		guard = { sql: 'EXISTS(SELECT 1 FROM polls WHERE id=? AND notified_at=?)', binds: [id, marker] },
		recipients = new Set([
			s.account_id,
			...(await all<{ account_id: string }>(env, 'SELECT DISTINCT account_id FROM poll_votes WHERE poll_id=?', id)).map(
				(r) => r.account_id
			),
		]),
		statements = [
			env.DB.prepare('UPDATE polls SET notified_at=? WHERE id=? AND notified_at IS NULL AND expires_at<=?').bind(
				marker,
				id,
				marker
			),
			env.DB.prepare('UPDATE statuses SET revision=revision+1 WHERE id=? AND ' + guard.sql).bind(s.id, ...guard.binds),
		]
	for (const account of recipients)
		statements.push(
			...(await notificationStatements(
				env,
				account,
				s.account_id,
				'poll',
				s.id,
				'poll-expired:' + id + ':' + p.expires_at + ':' + account,
				guard
			))
		)
	statements.push(
		env.DB.prepare(
			"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'status.event',?,?,? WHERE " +
				guard.sql
		).bind(
			'poll-closed:' + id + ':' + p.expires_at,
			JSON.stringify({ statusId: s.id }),
			Date.now(),
			Date.now(),
			...guard.binds
		)
	)
	await env.DB.batch(statements)
}
