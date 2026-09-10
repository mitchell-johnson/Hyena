import type { Env } from '../types'
import type { FederationDeliveryMetadata } from './history-types'

export function activityOrderingKey(activity: Record<string, unknown>, fallback?: string): string {
	const object = activity.object as Record<string, unknown> | string | undefined,
		follow =
			activity.type === 'Follow'
				? activity
				: activity.type === 'Undo' && typeof object === 'object' && object?.type === 'Follow'
					? object
					: null
	if (follow && typeof follow.actor === 'string' && typeof follow.object === 'string')
		return 'follow:' + JSON.stringify([follow.actor, follow.object])
	return typeof object === 'string' ? object : String(object?.id ?? activity.actor ?? fallback)
}

// Domain mutations and this statement belong to one D1 batch. Federation
// transforms and network requests only happen after the transaction commits.
export function outboundStatement(
	env: Env,
	actorId: string,
	activity: Record<string, unknown>,
	recipients: string[],
	id = crypto.randomUUID(),
	guard?: { sql: string; binds: (string | number | null)[] },
	delivery?: FederationDeliveryMetadata
) {
	return env.DB.prepare(
		`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'federation.send',?,?,? ${guard ? 'WHERE ' + guard.sql : ''}`
	).bind(
		'outbound:' + id,
		JSON.stringify({
			...delivery,
			actorId,
			orderingKey: 'outbox:' + activityOrderingKey(activity, actorId),
			activity: {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `${env.PUBLIC_ORIGIN}/activities/${id}`,
				...activity,
			},
			recipients,
		}),
		Date.now(),
		Date.now(),
		...(guard?.binds ?? [])
	)
}
