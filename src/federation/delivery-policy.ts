import type { Message } from '@fedify/fedify'
import { accountUri, all, one, parsed, statusUri } from '../data'
import { blocked, visible } from '../policy'
import { domainPolicy } from '../moderation-policy'
import type { Env, AccountRow, StatusRow } from '../types'
const uri = (v: unknown): string | null =>
	typeof v === 'string'
		? v
		: v && typeof v === 'object'
			? String((v as Record<string, unknown>).id ?? '') || null
			: null
export async function currentRecipients(env: Env, activity: Record<string, unknown>, ids: string[]) {
	const actorURI = uri(activity.actor),
		actor = actorURI
			? await one<AccountRow>(
					env,
					"SELECT * FROM accounts WHERE uri=? OR (domain='' AND ?=?||'/users/'||username)",
					actorURI,
					actorURI,
					env.PUBLIC_ORIGIN
				)
			: null
	const type = String(activity.type),
		isRemoval = ['Delete', 'Undo', 'Reject', 'Block'].includes(type),
		objectURI = uri(activity.object),
		status = objectURI
			? await one<StatusRow>(
					env,
					"SELECT s.* FROM statuses s JOIN accounts a ON a.id=s.account_id WHERE s.uri=? OR (a.domain='' AND ?=?||'/users/'||a.username||'/statuses/'||s.id)",
					objectURI,
					objectURI,
					env.PUBLIC_ORIGIN
				)
			: null
	if (actor && (actor.disabled || actor.suspended) && !isRemoval) return []
	if (status && ['Create', 'Update'].includes(type) && status.deleted_at) return []
	const allowed: string[] = []
	for (const id of ids) {
		const a = await one<AccountRow>(env, 'SELECT * FROM accounts WHERE id=? OR uri=?', id, id)
		if (!a || a.disabled || a.suspended || (a.domain && (await domainPolicy(env, a.domain)).suspended)) continue
		// A delayed Follow belongs to one particular request. An unfollow, or
		// a later re-follow with a fresh activity ID, cancels that old intent.
		if (
			type === 'Follow' &&
			(!actor ||
				objectURI !== accountUri(env, a) ||
				!(await one(
					env,
					'SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND activity_uri=?',
					actor.id,
					a.id,
					uri(activity.id)
				)))
		)
			continue
		if (actor && !isRemoval && (await blocked(env, actor.id, a.id))) continue
		if (
			actor &&
			!isRemoval &&
			(await one(env, 'SELECT 1 FROM user_domain_blocks WHERE account_id=? AND domain=?', actor.id, a.domain ?? ''))
		)
			continue
		if (status && !isRemoval && !(await visible(env, status, a.id))) continue
		allowed.push(a.id)
	}
	return allowed
}
// Recheck after the queue wait, not only when a user first posts. A revoked
// follower or blocked domain must not receive a previously queued private post.
export async function filterQueued(env: Env, message: Message): Promise<Message | null> {
	if (message.type === 'inbox') return message
	const activity = message.activity as Record<string, unknown>
	if (message.type === 'fanout') {
		const inboxes: Record<string, { actorIds: readonly string[]; sharedInbox: boolean }> = {}
		for (const [inbox, entry] of Object.entries(message.inboxes)) {
			if ((await domainPolicy(env, new URL(inbox).hostname)).suspended) continue
			const ids = await currentRecipients(env, activity, [...entry.actorIds])
			if (ids.length)
				inboxes[inbox] = {
					...entry,
					actorIds: await Promise.all(
						ids.map(async (id) =>
							accountUri(env, (await one<AccountRow>(env, 'SELECT * FROM accounts WHERE id=?', id))!)
						)
					),
				}
		}
		return Object.keys(inboxes).length ? { ...message, inboxes } : null
	}
	if ((await domainPolicy(env, new URL(message.inbox).hostname)).suspended) return null
	if (message.actorIds?.length && !(await currentRecipients(env, activity, [...message.actorIds])).length) return null
	return message
}
