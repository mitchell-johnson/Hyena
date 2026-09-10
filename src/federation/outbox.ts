import type { Env } from '../types'
// Domain mutations and this statement belong to one D1 batch. Federation
// transforms and network requests only happen after the transaction commits.
export function outboundStatement(
	env: Env,
	actorId: string,
	activity: Record<string, unknown>,
	recipients: string[],
	id = crypto.randomUUID(),
	guard?: { sql: string; binds: (string | number | null)[] }
) {
	return env.DB.prepare(
		`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'federation.send',?,?,? ${guard ? 'WHERE ' + guard.sql : ''}`
	).bind(
		'outbound:' + id,
		JSON.stringify({
			actorId,
			orderingKey:
				'outbox:' +
				(typeof activity.object === 'string'
					? activity.object
					: String((activity.object as Record<string, unknown> | undefined)?.id ?? activity.actor ?? actorId)),
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
