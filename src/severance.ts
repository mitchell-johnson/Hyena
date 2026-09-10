import { accountDomain } from './identity'
import { all, one, now, accountUri, type Bind } from './data'
import { nextId } from './db'
import { notificationStatements } from './notifications'
import { outboundStatement } from './federation/outbox'
import type { AccountRow, Env } from './types'

export interface RelationshipEvent {
	id: string
	account_id: string
	type: 'domain_block' | 'user_domain_block' | 'account_suspension'
	target_name: string
	created_at: string
}
export async function relationshipEventJSON(env: Env, row: RelationshipEvent) {
	const counts = await one<{ following_count: number; followers_count: number }>(
		env,
		"SELECT COALESCE(SUM(direction='following'),0) following_count,COALESCE(SUM(direction='followers'),0) followers_count FROM severed_relationships WHERE event_id=?",
		row.id
	)
	return {
		id: row.id,
		type: row.type,
		purged: false,
		target_name: row.target_name,
		...counts,
		created_at: row.created_at,
	}
}

// Include these statements in the moderation mutation's D1 batch. SQL takes the
// relationship snapshot before deletion; a racing repeat cannot invent losses.
export async function severanceStatements(
	env: Env,
	options: {
		type: RelationshipEvent['type']
		target: string
		targetAccountId?: string
		localAccountId?: string
	}
) {
	const predicate = options.targetAccountId
		? 'r.id=?'
		: options.type === 'domain_block'
			? "(r.domain=? OR r.domain LIKE '%.'||?)"
			: 'r.domain=?'
	const binds: Bind[] = options.targetAccountId
		? [options.targetAccountId]
		: options.type === 'domain_block'
			? [options.target, options.target]
			: [options.target]
	const locals = await all<AccountRow>(
		env,
		`SELECT * FROM accounts WHERE domain='' AND suspended=0 ${options.localAccountId ? 'AND id=?' : ''}`,
		...(options.localAccountId ? [options.localAccountId] : [])
	)
	const statements: D1PreparedStatement[] = []
	for (const local of locals) {
		if (local.id === options.targetAccountId) continue
		const affected = `(f.follower_id=? AND r.id=f.following_id OR f.following_id=? AND r.id=f.follower_id) AND ${predicate}`
		const relationships = await all<
			AccountRow & { follow_id: string; follower_id: string; following_id: string; activity_uri: string | null }
		>(
			env,
			`SELECT r.*,f.id follow_id,f.follower_id,f.following_id,f.activity_uri FROM follows f JOIN accounts r ON (${affected})`,
			local.id,
			local.id,
			...binds
		)
		if (!relationships.length) continue
		const event = await nextId(env.DB),
			eventKey = 'severance:' + event
		statements.push(
			env.DB.prepare(
				`INSERT INTO relationship_events(id,account_id,type,target_name,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM follows f JOIN accounts r ON (${affected}) AND f.state='accepted')`
			).bind(event, local.id, options.type, options.target, now(), local.id, local.id, ...binds),
			env.DB.prepare(
				`INSERT INTO severed_relationships SELECT ?,f.id,r.id,r.username||'@'||CASE WHEN r.domain='' THEN ? ELSE r.domain END,CASE WHEN f.follower_id=? THEN 'following' ELSE 'followers' END,f.reblogs,f.notify,f.languages FROM follows f JOIN accounts r ON (${affected}) WHERE f.state='accepted'`
			).bind(event, accountDomain(env), local.id, local.id, local.id, ...binds),
			...(await notificationStatements(env, local.id, local.id, 'severed_relationships', null, eventKey, {
				sql: 'EXISTS(SELECT 1 FROM relationship_events WHERE id=?)',
				binds: [event],
			})),
			env.DB.prepare('UPDATE notifications SET details=?,group_key=? WHERE event_key=?').bind(
				JSON.stringify({ event_id: event }),
				eventKey,
				eventKey
			)
		)
		// A user's domain mute severs remote follows using normal signed teardown.
		// Instance suspension deliberately stops all traffic to the banned domain.
		if (options.type === 'user_domain_block')
			for (const remote of relationships) {
				if (!remote.domain || !remote.activity_uri) continue
				const following = remote.follower_id === local.id
				statements.push(
					outboundStatement(
						env,
						local.id,
						{
							type: following ? 'Undo' : 'Reject',
							actor: accountUri(env, local),
							object: {
								id: remote.activity_uri,
								type: 'Follow',
								actor: accountUri(env, following ? local : remote),
								object: accountUri(env, following ? remote : local),
							},
						},
						[remote.id],
						'sever-' + event + '-' + remote.follow_id,
						{ sql: 'EXISTS(SELECT 1 FROM follows WHERE id=?)', binds: [remote.follow_id] }
					)
				)
			}
		statements.push(
			env.DB.prepare(
				`DELETE FROM follows WHERE id IN (SELECT f.id FROM follows f JOIN accounts r ON (${affected}))`
			).bind(local.id, local.id, ...binds),
			env.DB.prepare(
				`DELETE FROM list_accounts WHERE list_id IN (SELECT id FROM lists WHERE account_id=?) AND account_id IN (SELECT r.id FROM accounts r WHERE ${predicate})`
			).bind(local.id, ...binds)
		)
	}
	return statements
}
