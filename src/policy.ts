import type { Env, StatusRow } from './types'
import { one, type Bind } from './data'
import { allowedAccountSQL } from './moderation-policy'

// The same predicate is used before pagination and on direct reads. Mutes are
// presentation rules; blocks and recipient membership are access controls.
export function audienceSQL(viewer: string | null, alias = 'statuses'): { sql: string; binds: Bind[] } {
	const s = alias
	return {
		sql: `${s}.deleted_at IS NULL AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=${s}.account_id AND a.suspended=0 AND ${allowedAccountSQL()})
 AND (${s}.account_id=? OR ${s}.visibility IN ('public','unlisted')
 OR EXISTS(SELECT 1 FROM status_recipients r WHERE r.status_id=${s}.id AND r.account_id=?)
 OR (${s}.visibility='private' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=${s}.account_id AND f.state='accepted')))
 AND NOT EXISTS(SELECT 1 FROM account_actions b WHERE b.kind='block' AND ((b.account_id=? AND b.target_id=${s}.account_id) OR (b.target_id=? AND b.account_id=${s}.account_id)))
 AND NOT EXISTS(SELECT 1 FROM user_domain_blocks d JOIN accounts a ON a.domain=d.domain WHERE d.account_id=? AND a.id=${s}.account_id)`,
		binds: [viewer, viewer, viewer, viewer, viewer, viewer],
	}
}
export async function visible(env: Env, status: StatusRow, viewer: string | null): Promise<boolean> {
	const p = audienceSQL(viewer)
	return !!(await one(env, `SELECT id FROM statuses WHERE id=? AND ${p.sql}`, status.id, ...p.binds))
}
export async function blocked(env: Env, a: string, b: string): Promise<boolean> {
	return !!(await one(
		env,
		`SELECT 1 FROM account_actions WHERE kind='block' AND ((account_id=? AND target_id=?) OR (account_id=? AND target_id=?))`,
		a,
		b,
		b,
		a
	))
}
export function mutedSQL(viewer: string | null, alias = 'statuses') {
	return {
		sql: `NOT EXISTS(SELECT 1 FROM account_actions m WHERE m.account_id=? AND m.target_id=${alias}.account_id AND m.kind='mute' AND (m.expires_at IS NULL OR m.expires_at>?))`,
		binds: [viewer, Date.now()] as Bind[],
	}
}
