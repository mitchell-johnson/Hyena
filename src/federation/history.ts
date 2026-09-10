import type { Env, JobRow, StatusRow } from '../types'
import { accountById, accountUri, one, statusUri } from '../data'
import { digest } from '../auth/crypto'
import { blocked } from '../policy'
import { domainPolicy } from '../moderation-policy'
import { activityObject } from './objects'
import { outboundStatement } from './outbox'
import type { FollowHistoryGuard } from './history-types'

interface AcceptedFollow {
	actorId: string
	followerId: string
	followUri: string
	acceptedAt: string
}
export interface FollowHistoryPayload extends AcceptedFollow {
	statusIds: string[]
	acceptJobId: string
}

const acceptedFollowSql = `EXISTS(SELECT 1 FROM follows f JOIN accounts a ON a.id=f.following_id JOIN accounts r ON r.id=f.follower_id WHERE f.following_id=? AND f.follower_id=? AND f.activity_uri=? AND f.state='accepted' AND a.domain='' AND a.disabled=0 AND a.suspended=0 AND r.domain<>'' AND r.disabled=0 AND r.suspended=0)`
const followBinds = (follow: Pick<AcceptedFollow, 'actorId' | 'followerId' | 'followUri'>) => [
	follow.actorId,
	follow.followerId,
	follow.followUri,
]

// Snapshot IDs in the same transaction that accepts the follow. Retries must
// never widen the selection when a post is deleted or a backdated post arrives.
export async function followHistoryStatement(env: Env, follow: AcceptedFollow) {
	const id = await digest(JSON.stringify(followBinds(follow))),
		acceptId = 'accept-' + (await digest(follow.followUri)),
		time = Date.now()
	return env.DB.prepare(
		`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at)
		SELECT ?,'federation.history',json_set(?,'$.statusIds',json((SELECT json_group_array(id) FROM (
			SELECT id FROM statuses WHERE account_id=? AND local=1 AND visibility='public' AND deleted_at IS NULL AND reblog_of_id IS NULL AND created_at<=? ORDER BY sequence DESC LIMIT 20
		)))),?,? WHERE ${acceptedFollowSql}`
	).bind(
		'follow-history:' + id,
		JSON.stringify({ ...follow, acceptJobId: 'outbound:' + acceptId }),
		follow.actorId,
		follow.acceptedAt,
		time,
		time,
		...followBinds(follow)
	)
}

export async function followHistoryAllowed(
	env: Env,
	follow: Pick<AcceptedFollow, 'actorId' | 'followerId' | 'followUri'> & { statusId?: string }
) {
	if (!(await one(env, 'SELECT 1 WHERE ' + acceptedFollowSql, ...followBinds(follow)))) return false
	const follower = await accountById(env, follow.followerId)
	if (
		(await blocked(env, follow.actorId, follow.followerId)) ||
		(await domainPolicy(env, follower.domain!)).suspended ||
		(await one(
			env,
			'SELECT 1 FROM user_domain_blocks WHERE account_id=? AND domain=?',
			follow.actorId,
			follower.domain!
		))
	)
		return false
	return (
		!follow.statusId ||
		!!(await one(
			env,
			"SELECT 1 FROM statuses WHERE id=? AND account_id=? AND local=1 AND visibility='public' AND deleted_at IS NULL AND reblog_of_id IS NULL",
			follow.statusId,
			follow.actorId
		))
	)
}

// An enqueued Accept is not yet delivered. Retry-After and remote failures
// must hold history until the follower's server has actually accepted it.
export async function followHistoryReadiness(
	env: Env,
	payload: FollowHistoryPayload
): Promise<'ready' | 'wait' | 'cancel'> {
	if (!(await followHistoryAllowed(env, payload))) return 'cancel'
	const accept = await one<JobRow>(env, 'SELECT * FROM jobs WHERE id=?', payload.acceptJobId)
	if (!accept || accept.state === 'dead') return 'cancel'
	if (accept.state !== 'done') return 'wait'
	const { activity } = JSON.parse(accept.payload) as { activity: { id: string } },
		delivery = await one<JobRow>(
			env,
			"SELECT * FROM jobs WHERE kind='federation.message' AND json_extract(payload,'$.activityId')=? AND json_extract(payload,'$.messageType')='outbox' ORDER BY rowid DESC LIMIT 1",
			activity.id
		)
	if (!delivery || delivery.state === 'dead') return 'cancel'
	if (delivery.state !== 'done') return 'wait'
	return JSON.parse(delivery.payload).delivered === 1 ? 'ready' : 'cancel'
}

export async function processFollowHistory(env: Env, payload: FollowHistoryPayload) {
	if (!(await followHistoryAllowed(env, payload))) return
	const actor = await accountById(env, payload.actorId),
		followId = await digest(JSON.stringify(followBinds(payload)))
	// Oldest first within the frozen recent selection, preserving post order.
	for (const id of payload.statusIds.slice(0, 20).reverse()) {
		const guard: FollowHistoryGuard = {
			actorId: actor.id,
			followerId: payload.followerId,
			followUri: payload.followUri,
			statusId: id,
		}
		if (!(await followHistoryAllowed(env, guard))) continue
		const status = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', id)
		if (!status) continue
		const uri = statusUri(env, status, actor),
			jobId = `history-${followId}-${id}`,
			condition = {
				sql: `${acceptedFollowSql} AND EXISTS(SELECT 1 FROM statuses WHERE id=? AND account_id=? AND revision=? AND visibility='public' AND deleted_at IS NULL)`,
				binds: [...followBinds(payload), id, actor.id, status.revision],
			}
		const result = await env.DB.batch([
			outboundStatement(
				env,
				actor.id,
				{
					id: uri + '#create',
					type: 'Create',
					actor: accountUri(env, actor),
					published: status.created_at,
					object: await activityObject(env, status),
				},
				[payload.followerId],
				jobId,
				condition,
				{ followHistory: guard }
			),
			// Once a Create intent exists, later edits must use Update, rather
			// than reusing the already deduplicated Create activity ID.
			env.DB.prepare(
				`UPDATE statuses SET federation_started=1 WHERE id=? AND ${condition.sql} AND EXISTS(SELECT 1 FROM jobs WHERE id=?)`
			).bind(id, ...condition.binds, 'outbound:' + jobId),
		])
		if (
			!result[0]!.meta.changes &&
			!(await one(env, 'SELECT 1 FROM jobs WHERE id=?', 'outbound:' + jobId)) &&
			(await followHistoryAllowed(env, guard))
		)
			throw new Error('Post changed while preparing follow history; retry the frozen selection')
	}
}
