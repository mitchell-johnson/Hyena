import { conversationJSON } from './conversations'
import type { AccountRow, Env, StatusRow } from './types'
import { all, one, now, parsed } from './data'
import { visible, blocked } from './policy'
import { matchesFilters, statusJSON } from './serializers'
import { notificationStatements } from './notifications'
import { federateStatus } from './federation'
import { limitedAccountSQL } from './moderation-policy'
export async function statusEvent(env: Env, s: StatusRow) {
	if (!s.reblog_of_id) await federateStatus(env, s)
	const limited = await one(env, `SELECT 1 FROM accounts a WHERE a.id=? AND ${limitedAccountSQL()}`, s.account_id)
	const locals = await all<AccountRow>(env, "SELECT * FROM accounts WHERE domain='' AND suspended=0 AND disabled=0"),
		recipients = await all<{ account_id: string; mentioned: number }>(
			env,
			'SELECT account_id,mentioned FROM status_recipients WHERE status_id=?',
			s.id
		),
		tags = await all<{ tag: string }>(env, 'SELECT tag FROM status_tags WHERE status_id=?', s.id)
	for (const viewer of locals) {
		const following = await one<{ notify: number; reblogs: number; languages: string }>(
				env,
				"SELECT * FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
				viewer.id,
				s.account_id
			),
			mentioned = recipients.some((r) => r.account_id === viewer.id),
			owner = viewer.id === s.account_id
		if (await blocked(env, viewer.id, s.account_id)) continue
		if (!s.deleted_at && !(await visible(env, s, viewer.id))) continue
		if (s.deleted_at && !owner && !mentioned && !following && !['public', 'unlisted'].includes(s.visibility)) continue
		const muted = await one(
			env,
			"SELECT 1 FROM account_actions WHERE account_id=? AND target_id=? AND kind='mute' AND (expires_at IS NULL OR expires_at>?)",
			viewer.id,
			s.account_id,
			Date.now()
		)
		if (muted) continue
		const sources: string[] = [],
			followedTag = tags.length
				? await one(
						env,
						`SELECT 1 FROM account_tags WHERE account_id=? AND kind='follow' AND tag IN (${tags.map(() => '?').join(',')})`,
						viewer.id,
						...tags.map((t) => t.tag)
					)
				: null
		const exclusive = await one(
			env,
			'SELECT 1 FROM lists l JOIN list_accounts m ON m.list_id=l.id WHERE l.account_id=? AND l.exclusive=1 AND m.account_id=?',
			viewer.id,
			s.account_id
		)
		if (
			owner ||
			(!exclusive &&
				((following &&
					(!s.reblog_of_id || following.reblogs) &&
					(following.languages === '[]' ||
						!s.language ||
						parsed<string[]>(following.languages, []).includes(s.language))) ||
					(followedTag && s.visibility === 'public')))
		)
			sources.push('user')
		if (s.visibility === 'direct' && (owner || mentioned)) sources.push('direct')
		if (s.visibility === 'public' && !limited) {
			sources.push('public', s.local ? 'public:local' : 'public:remote')
			if (await one(env, 'SELECT 1 FROM media_attachments WHERE status_id=?', s.id))
				sources.push('public:media', s.local ? 'public:local:media' : 'public:remote:media')
			for (const t of tags) {
				sources.push('hashtag|' + t.tag)
				if (s.local) sources.push('hashtag:local|' + t.tag)
			}
		}
		const lists = await all<{ id: string; replies_policy: string }>(
			env,
			'SELECT l.* FROM lists l JOIN list_accounts m ON m.list_id=l.id WHERE l.account_id=? AND m.account_id=?',
			viewer.id,
			s.account_id
		)
		for (const l of lists) {
			if (s.in_reply_to_id) {
				if (l.replies_policy === 'none') continue
				const parent = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', s.in_reply_to_id)
				if (!parent) continue
				if (
					l.replies_policy === 'list' &&
					!(await one(env, 'SELECT 1 FROM list_accounts WHERE list_id=? AND account_id=?', l.id, parent.account_id))
				)
					continue
				if (
					l.replies_policy === 'followed' &&
					!(await one(
						env,
						"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
						viewer.id,
						parent.account_id
					))
				)
					continue
			}
			sources.push('list|' + l.id)
		}
		if (sources.length)
			await env.STREAMS.get(env.STREAMS.idFromName(viewer.id)).publish({
				id: s.id,
				revision: s.revision,
				event: s.deleted_at ? 'delete' : s.revision > 1 ? 'status.update' : 'update',
				payload: s.deleted_at ? s.id : JSON.stringify(await statusJSON(env, s, viewer.id)),
				public: s.visibility === 'public',
				sources,
			})
		if (!s.deleted_at && !s.reblog_of_id) {
			const type = mentioned ? 'mention' : following?.notify ? 'status' : null
			if (type) {
				const statements = await notificationStatements(
					env,
					viewer.id,
					s.account_id,
					type,
					s.id,
					`${type}:${s.id}:${viewer.id}`
				)
				if (statements.length) await env.DB.batch(statements)
			}
			if (s.visibility === 'direct' && (owner || mentioned)) {
				const id = s.conversation_id ?? s.id
				await env.DB.prepare(
					'INSERT INTO conversations(id,account_id,last_status_id,unread) VALUES(?,?,?,?) ON CONFLICT(id,account_id) DO UPDATE SET last_status_id=CASE WHEN CAST(excluded.last_status_id AS INTEGER)>CAST(conversations.last_status_id AS INTEGER) THEN excluded.last_status_id ELSE conversations.last_status_id END,unread=MAX(conversations.unread,excluded.unread),deleted=0'
				)
					.bind(id, viewer.id, s.id, owner ? 0 : 1)
					.run()
				await env.STREAMS.get(env.STREAMS.idFromName(viewer.id)).sendEvent(
					'conversation',
					JSON.stringify(await conversationJSON(env, id, viewer.id)),
					['direct', 'user']
				)
			}
		}
	}
}
