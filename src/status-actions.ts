import { Hono } from 'hono'
import { authenticate, optionalAccount } from './auth/access'
import { nextId } from './db'
import {
	all,
	one,
	run,
	parsed,
	list,
	object,
	now,
	accountById,
	accountUri,
	statusUri,
	cursors,
	pageLimit,
	links,
} from './data'
import { ApiError, boolField, readInput, stringField } from './http'
import { accountJSON, statusJSON, mediaJSON, pollJSON, emojiJSON } from './serializers'
import { audienceSQL, visible } from './policy'
import { outboundStatement } from './federation/outbox'
import { notificationStatements } from './notifications'
import { writeStatus, normalize } from './statuses'
import { postExtras } from './post-extras'
import type { AccountRow, AppEnv, Env, MediaRow, StatusRow } from './types'
export const statusActions = new Hono<AppEnv>()
export async function requireStatus(env: Env, id: string, viewer: string | null) {
	const s = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', id)
	if (!s || !(await visible(env, s, viewer))) throw new ApiError(404, 'Record not found')
	return s
}

for (const [action, kind, remove, scope] of [
	['favourite', 'favourite', false, 'favourites'],
	['unfavourite', 'favourite', true, 'favourites'],
	['bookmark', 'bookmark', false, 'bookmarks'],
	['unbookmark', 'bookmark', true, 'bookmarks'],
	['mute', 'mute', false, 'statuses'],
	['unmute', 'mute', true, 'statuses'],
	['pin', 'pin', false, 'accounts'],
	['unpin', 'pin', true, 'accounts'],
] as const)
	statusActions.post('/api/v1/statuses/:id/' + action, async (c) => {
		await authenticate(c, 'write:' + scope)
		const a = c.get('account'),
			s = await requireStatus(c.env, c.req.param('id')!, a.id)
		if (kind === 'pin' && (s.account_id !== a.id || s.reblog_of_id || !['public', 'unlisted'].includes(s.visibility)))
			throw new ApiError(422, 'This post cannot be pinned')
		const old = await one<{ id: string; activity_uri: string | null }>(
			c.env,
			'SELECT * FROM interactions WHERE account_id=? AND status_id=? AND kind=?',
			a.id,
			s.id,
			kind
		)
		if (!!old !== !remove) {
			const id = await nextId(c.env.DB),
				uri = `${c.env.PUBLIC_ORIGIN}/activities/${crypto.randomUUID()}`,
				statements = [
					remove
						? c.env.DB.prepare('DELETE FROM interactions WHERE account_id=? AND status_id=? AND kind=?').bind(
								a.id,
								s.id,
								kind
							)
						: c.env.DB.prepare(
								'INSERT OR IGNORE INTO interactions(id,account_id,status_id,kind,activity_uri,created_at) VALUES(?,?,?,?,?,?)'
							).bind(id, a.id, s.id, kind, uri, now()),
				]
			if (kind === 'favourite') {
				const target = await accountById(c.env, s.account_id),
					like = {
						id: old?.activity_uri ?? uri,
						type: 'Like',
						actor: accountUri(c.env, a),
						object: statusUri(c.env, s, target),
					}
				statements.push(
					outboundStatement(c.env, a.id, remove ? { type: 'Undo', actor: accountUri(c.env, a), object: like } : like, [
						target.id,
					])
				)
				if (!remove)
					statements.push(
						...(await notificationStatements(c.env, s.account_id, a.id, 'favourite', s.id, 'favourite:' + id))
					)
			}
			if (kind === 'pin') {
				const followers = await all<{ follower_id: string }>(
					c.env,
					"SELECT follower_id FROM follows WHERE following_id=? AND state='accepted'",
					a.id
				)
				statements.push(
					outboundStatement(
						c.env,
						a.id,
						{
							type: remove ? 'Remove' : 'Add',
							actor: accountUri(c.env, a),
							object: statusUri(c.env, s, a),
							target: accountUri(c.env, a) + '/collections/featured',
						},
						followers.map((f) => f.follower_id)
					)
				)
			}
			if (kind === 'pin' && !remove) {
				statements.unshift(
					c.env.DB.prepare(
						"INSERT INTO transaction_guards VALUES(?,CASE WHEN (SELECT COUNT(*) FROM interactions WHERE account_id=? AND kind='pin')<5 THEN 1 ELSE 0 END)"
					).bind(id, a.id)
				)
				statements.push(c.env.DB.prepare('DELETE FROM transaction_guards WHERE id=?').bind(id))
			}
			try {
				await c.env.DB.batch(statements)
			} catch (error) {
				if (kind === 'pin' && String(error).includes('CHECK constraint failed'))
					throw new ApiError(422, 'Maximum five pinned posts')
				throw error
			}
		}
		return c.json(await statusJSON(c.env, s, a.id))
	})
statusActions.post('/api/v1/statuses/:id/reblog', async (c) => {
	await authenticate(c, 'write:statuses')
	const a = c.get('account'),
		s = await requireStatus(c.env, c.req.param('id'), a.id)
	if (s.reblog_of_id) return c.json(await statusJSON(c.env, s, a.id))
	if (!['public', 'unlisted'].includes(s.visibility))
		throw new ApiError(422, 'Only public or unlisted posts can be boosted')
	let boost = await one<StatusRow>(
		c.env,
		'SELECT * FROM statuses WHERE account_id=? AND reblog_of_id=? AND deleted_at IS NULL',
		a.id,
		s.id
	)
	if (!boost) {
		const input = c.req.header('content-type') ? await readInput(c.req.raw) : {},
			visibility = stringField(input, 'visibility', 'public')
		if (!['public', 'unlisted', 'private'].includes(visibility)) throw new ApiError(422, 'Invalid boost visibility')
		const id = await nextId(c.env.DB),
			uri = `${accountUri(c.env, a)}/statuses/${id}`,
			target = await accountById(c.env, s.account_id),
			followers = await all<{ follower_id: string }>(
				c.env,
				"SELECT follower_id FROM follows WHERE following_id=? AND state='accepted'",
				a.id
			)
		await c.env.DB.batch([
			c.env.DB.prepare(
				`INSERT OR IGNORE INTO statuses(id,sequence,account_id,text,content,visibility,created_at,mutation_id,uri,reblog_of_id) VALUES(?,CAST(? AS INTEGER),?,'','',?,?,?,?,?)`
			).bind(id, id, a.id, visibility, now(), crypto.randomUUID(), uri, s.id),
			outboundStatement(
				c.env,
				a.id,
				{
					id: uri,
					type: 'Announce',
					actor: accountUri(c.env, a),
					object: statusUri(c.env, s, target),
					to:
						visibility === 'public'
							? ['https://www.w3.org/ns/activitystreams#Public']
							: [accountUri(c.env, a) + '/followers'],
				},
				[target.id, ...followers.map((f) => f.follower_id)],
				id,
				{ sql: 'EXISTS(SELECT 1 FROM statuses WHERE id=?)', binds: [id] }
			),
			...(await notificationStatements(c.env, s.account_id, a.id, 'reblog', s.id, 'boost:' + id, {
				sql: 'EXISTS(SELECT 1 FROM statuses WHERE id=?)',
				binds: [id],
			})),
			c.env.DB.prepare(
				`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'status.event',?,?,?)`
			).bind('status:' + id + ':1', JSON.stringify({ statusId: id }), Date.now(), Date.now()),
		])
		boost = (await one<StatusRow>(
			c.env,
			'SELECT * FROM statuses WHERE account_id=? AND reblog_of_id=? AND deleted_at IS NULL',
			a.id,
			s.id
		))!
	}
	return c.json(await statusJSON(c.env, boost, a.id))
})
statusActions.post('/api/v1/statuses/:id/unreblog', async (c) => {
	await authenticate(c, 'write:statuses')
	const a = c.get('account'),
		s = await requireStatus(c.env, c.req.param('id'), a.id),
		boost = await one<StatusRow>(
			c.env,
			'SELECT * FROM statuses WHERE account_id=? AND reblog_of_id=? AND deleted_at IS NULL',
			a.id,
			s.id
		)
	if (boost) {
		const target = await accountById(c.env, s.account_id),
			followers = await all<{ follower_id: string }>(
				c.env,
				"SELECT follower_id FROM follows WHERE following_id=? AND state='accepted'",
				a.id
			)
		await c.env.DB.batch([
			c.env.DB.prepare('UPDATE statuses SET deleted_at=?,revision=revision+1 WHERE id=?').bind(now(), boost.id),
			c.env.DB.prepare(
				"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'status.event',?,?,? WHERE EXISTS(SELECT 1 FROM statuses WHERE id=? AND deleted_at IS NOT NULL)"
			).bind('status-unboost:' + boost.id, JSON.stringify({ statusId: boost.id }), Date.now(), Date.now(), boost.id),
			outboundStatement(
				c.env,
				a.id,
				{
					type: 'Undo',
					actor: accountUri(c.env, a),
					object: { id: boost.uri, type: 'Announce', actor: accountUri(c.env, a), object: statusUri(c.env, s, target) },
				},
				[target.id, ...followers.map((f) => f.follower_id)]
			),
		])
	}
	return c.json(await statusJSON(c.env, s, a.id))
})
for (const type of ['favourited_by', 'reblogged_by'] as const)
	statusActions.get('/api/v1/statuses/:id/' + type, async (c) => {
		const viewer = await optionalAccount(c),
			s = await requireStatus(c.env, c.req.param('id')!, viewer)
		const rows =
			type === 'favourited_by'
				? await all<AccountRow>(
						c.env,
						"SELECT a.* FROM accounts a JOIN interactions i ON i.account_id=a.id WHERE i.status_id=? AND i.kind='favourite' AND a.suspended=0 LIMIT ?",
						s.id,
						pageLimit(c)
					)
				: await all<AccountRow>(
						c.env,
						'SELECT a.* FROM accounts a JOIN statuses s ON s.account_id=a.id WHERE s.reblog_of_id=? AND s.deleted_at IS NULL AND a.suspended=0 LIMIT ?',
						s.id,
						pageLimit(c)
					)
		return c.json(await Promise.all(rows.map((a) => accountJSON(c.env, a))))
	})
for (const [path, kind] of [
	['favourites', 'favourite'],
	['bookmarks', 'bookmark'],
] as const)
	statusActions.get('/api/v1/' + path, async (c) => {
		await authenticate(c, 'read:' + path)
		const viewer = c.get('account').id,
			p = audienceSQL(viewer, 's'),
			cur = cursors(c, 'i.id'),
			rows = await all<StatusRow & { cursor_id: string }>(
				c.env,
				`SELECT s.*,i.id cursor_id FROM statuses s JOIN interactions i ON i.status_id=s.id WHERE i.account_id=? AND i.kind=? AND ${p.sql} ${cur.sql} ORDER BY CAST(i.id AS INTEGER) ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
				viewer,
				kind,
				...p.binds,
				...cur.binds,
				pageLimit(c)
			)
		if (cur.ascending) rows.reverse()
		links(
			c,
			rows.map((s) => ({ id: s.cursor_id }))
		)
		return c.json(await Promise.all(rows.map((s) => statusJSON(c.env, s, viewer))))
	})
statusActions.get('/api/v1/statuses', async (c) => {
	const viewer = await optionalAccount(c),
		ids = c.req.queries('id[]') ?? []
	if (ids.length > 100) throw new ApiError(422, 'Too many statuses')
	return c.json(
		await Promise.all(ids.map(async (id) => statusJSON(c.env, await requireStatus(c.env, id, viewer), viewer)))
	)
})
statusActions.get('/api/v1/statuses/:id/history', async (c) => {
	const viewer = await optionalAccount(c),
		s = await requireStatus(c.env, c.req.param('id'), viewer),
		a = await accountJSON(c.env, await accountById(c.env, s.account_id)),
		revisions = await all<{ snapshot: string; created_at: string }>(
			c.env,
			'SELECT snapshot,created_at FROM status_revisions WHERE status_id=? ORDER BY revision',
			s.id
		)
	return c.json(
		await Promise.all(
			revisions.map(async (r) => {
				const value = parsed<StatusRow & { media_ids?: string[]; media_attachments?: unknown[]; poll?: unknown }>(
						r.snapshot,
						s
					),
					media = []
				for (const id of value.media_ids ?? []) {
					const m = await one<MediaRow>(c.env, 'SELECT * FROM media_attachments WHERE id=?', id)
					if (m) media.push(mediaJSON(c.env, m))
				}
				return {
					content: value.content,
					spoiler_text: value.spoiler_text,
					sensitive: !!value.sensitive,
					created_at: r.created_at,
					account: a,
					media_attachments: value.media_attachments ?? media,
					emojis: await emojiJSON(c.env, value.text),
					poll: value.poll ?? null,
				}
			})
		)
	)
})
statusActions.put('/api/v1/statuses/:id/interaction_policy', async (c) => {
	await authenticate(c, 'write:statuses')
	const a = c.get('account'),
		s = await requireStatus(c.env, c.req.param('id'), a.id)
	if (s.account_id !== a.id) throw new ApiError(404, 'Record not found')
	const policy = stringField(await readInput(c.req.raw), 'quote_approval_policy')
	if (!['public', 'followers', 'nobody'].includes(policy)) throw new ApiError(422, 'Invalid quote policy')
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE statuses SET quote_policy=?,revision=revision+1,edited_at=? WHERE id=?').bind(
			policy,
			now(),
			s.id
		),
		c.env.DB.prepare(`INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'status.event',?,?,?)`).bind(
			'status-policy:' + crypto.randomUUID(),
			JSON.stringify({ statusId: s.id }),
			Date.now(),
			Date.now()
		),
	])
	return c.json(
		await statusJSON(c.env, (await one<StatusRow>(c.env, 'SELECT * FROM statuses WHERE id=?', s.id))!, a.id)
	)
})
statusActions.get('/api/v1/statuses/:id/quotes', async (c) => {
	const viewer = await optionalAccount(c),
		s = await requireStatus(c.env, c.req.param('id'), viewer),
		p = audienceSQL(viewer),
		cur = cursors(c)
	const rows = await all<StatusRow>(
		c.env,
		`SELECT * FROM statuses WHERE quote_id=? AND quote_state='accepted' AND ${p.sql} ${cur.sql} ORDER BY sequence ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
		s.id,
		...p.binds,
		...cur.binds,
		pageLimit(c)
	)
	if (cur.ascending) rows.reverse()
	links(c, rows)
	return c.json(await Promise.all(rows.map((s) => statusJSON(c.env, s, viewer))))
})
statusActions.post('/api/v1/statuses/:id/quotes/:quote/revoke', async (c) => {
	await authenticate(c, 'write:statuses')
	const a = c.get('account'),
		s = await requireStatus(c.env, c.req.param('id'), a.id),
		q = await one<StatusRow>(c.env, 'SELECT * FROM statuses WHERE id=? AND quote_id=?', c.req.param('quote'), s.id)
	if (s.account_id !== a.id || !q) throw new ApiError(404, 'Record not found')
	const target = await accountById(c.env, q.account_id)
	await c.env.DB.batch([
		c.env.DB.prepare("UPDATE statuses SET quote_state='revoked' WHERE id=?").bind(q.id),
		outboundStatement(
			c.env,
			a.id,
			{ type: 'Delete', actor: accountUri(c.env, a), object: { type: 'Tombstone', id: q.quote_authorization } },
			[target.id]
		),
	])
	return c.json(await statusJSON(c.env, { ...q, quote_state: 'revoked' }, a.id))
})

statusActions.get('/api/v1/polls/:id', async (c) => {
	const viewer = await optionalAccount(c),
		p = await one<{ status_id: string }>(c.env, 'SELECT status_id FROM polls WHERE id=?', c.req.param('id'))
	if (!p) throw new ApiError(404, 'Record not found')
	await requireStatus(c.env, p.status_id, viewer)
	return c.json(await pollJSON(c.env, p.status_id, viewer))
})
statusActions.post('/api/v1/polls/:id/votes', async (c) => {
	await authenticate(c, 'write:statuses')
	const a = c.get('account'),
		p = await one<{ id: string; status_id: string; multiple: number; options: string; expires_at: string }>(
			c.env,
			'SELECT * FROM polls WHERE id=?',
			c.req.param('id')
		)
	if (!p) throw new ApiError(404, 'Record not found')
	const s = await requireStatus(c.env, p.status_id, a.id),
		raw = (await readInput(c.req.raw)).choices
	if (!Array.isArray(raw) || !raw.length || raw.length > 4) throw new ApiError(422, 'Choose poll options')
	const choices = raw.map(Number),
		options = parsed<string[]>(p.options, [])
	if (
		Date.parse(p.expires_at) <= Date.now() ||
		choices.some((x) => !Number.isInteger(x) || x < 0 || x >= options.length) ||
		new Set(choices).size !== choices.length ||
		(!p.multiple && choices.length !== 1)
	)
		throw new ApiError(422, 'Invalid or expired poll vote')
	const mutation = crypto.randomUUID(),
		statements = [
			c.env.DB.prepare('INSERT OR IGNORE INTO poll_ballots(poll_id,account_id,mutation_id) VALUES(?,?,?)').bind(
				p.id,
				a.id,
				mutation
			),
		]
	for (const choice of choices) {
		const id = await nextId(c.env.DB)
		statements.push(
			c.env.DB.prepare(
				'INSERT OR IGNORE INTO poll_votes(id,poll_id,account_id,choice,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM poll_ballots WHERE poll_id=? AND account_id=? AND mutation_id=?)'
			).bind(id, p.id, a.id, choice, now(), p.id, a.id, mutation)
		)
		if (!s.local) {
			const target = await accountById(c.env, s.account_id)
			statements.push(
				outboundStatement(
					c.env,
					a.id,
					{
						type: 'Create',
						actor: accountUri(c.env, a),
						object: {
							id: `${accountUri(c.env, a)}/votes/${id}`,
							type: 'Note',
							name: options[choice],
							attributedTo: accountUri(c.env, a),
							inReplyTo: statusUri(c.env, s, target),
							to: [accountUri(c.env, target)],
						},
					},
					[target.id],
					id,
					{
						sql: 'EXISTS(SELECT 1 FROM poll_ballots WHERE poll_id=? AND account_id=? AND mutation_id=?)',
						binds: [p.id, a.id, mutation],
					}
				)
			)
		}
	}
	statements.push(
		c.env.DB.prepare(
			'UPDATE statuses SET revision=revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM poll_ballots WHERE poll_id=? AND account_id=? AND mutation_id=?)'
		).bind(s.id, p.id, a.id, mutation),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'status.event',?,?,? WHERE EXISTS(SELECT 1 FROM poll_ballots WHERE poll_id=? AND account_id=? AND mutation_id=?)"
		).bind('poll-vote:' + mutation, JSON.stringify({ statusId: s.id }), Date.now(), Date.now(), p.id, a.id, mutation)
	)
	const result = await c.env.DB.batch(statements)
	if (!result[0]!.meta.changes) throw new ApiError(422, 'You have already voted')
	return c.json(await pollJSON(c.env, s.id, a.id))
})

type ScheduledRow = {
	id: string
	account_id: string
	params: string
	scheduled_at: string
	state: string
	status_id: string | null
}
async function scheduledJSON(env: Env, s: ScheduledRow) {
	const params = parsed<Record<string, unknown>>(s.params, {})
	delete params.application_id
	return {
		id: s.id,
		scheduled_at: s.scheduled_at,
		params,
		media_attachments: (
			await all<MediaRow>(env, 'SELECT * FROM media_attachments WHERE scheduled_id=? ORDER BY position', s.id)
		).map((m) => mediaJSON(env, m)),
	}
}
export async function scheduleStatus(env: Env, account: AccountRow, appId: string, input: Record<string, unknown>) {
	const at = Date.parse(stringField(input, 'scheduled_at'))
	if (!Number.isFinite(at) || at < Date.now() + 300000)
		throw new ApiError(422, 'Schedule at least five minutes in the future')
	const value = normalize(input),
		id = await nextId(env.DB),
		media = value.media ?? []
	if (!value.text && !media.length) throw new ApiError(422, 'A status needs text or media')
	await postExtras(env, account, id, input, value.text, value.visibility)
	const params = { ...input, scheduled_at: undefined, application_id: appId },
		count = `(SELECT COUNT(*) FROM media_attachments WHERE id IN (${media.map(() => '?').join(',') || 'NULL'}) AND account_id=? AND state='ready' AND status_id IS NULL AND scheduled_id IS NULL)=?`
	const statements = [
		env.DB.prepare(
			`INSERT INTO scheduled_statuses(id,account_id,params,scheduled_at,created_at) SELECT ?,?,?,?,? WHERE ${count}`
		).bind(
			id,
			account.id,
			JSON.stringify(params),
			new Date(at).toISOString(),
			now(),
			...media,
			account.id,
			media.length
		),
		...media.map((m, i) =>
			env.DB.prepare(
				'UPDATE media_attachments SET scheduled_id=?,position=? WHERE id=? AND EXISTS(SELECT 1 FROM scheduled_statuses WHERE id=?)'
			).bind(id, i, m, id)
		),
		env.DB.prepare(
			`INSERT INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'schedule.publish',?,?,? WHERE EXISTS(SELECT 1 FROM scheduled_statuses WHERE id=?)`
		).bind('schedule:' + id, JSON.stringify({ scheduleId: id }), at, Date.now(), id),
	]
	const result = await env.DB.batch(statements)
	if (!result[0]!.meta.changes) throw new ApiError(422, 'Scheduled media is unavailable')
	return scheduledJSON(env, (await one<ScheduledRow>(env, 'SELECT * FROM scheduled_statuses WHERE id=?', id))!)
}
export async function publishScheduled(env: Env, id: string) {
	const s = await one<ScheduledRow>(env, 'SELECT * FROM scheduled_statuses WHERE id=?', id)
	if (!s || s.state === 'done' || s.state === 'cancelled') return
	if (Date.parse(s.scheduled_at) > Date.now()) return
	const input = parsed<Record<string, unknown>>(s.params, {}),
		a = await accountById(env, s.account_id)
	if (a.disabled || a.suspended) throw new ApiError(422, 'Scheduled account is disabled')
	const posted = await writeStatus(
		env,
		a,
		String(input.application_id),
		Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'application_id')),
		undefined,
		'schedule:' + id,
		id
	)
	await run(env, "UPDATE scheduled_statuses SET state='done',status_id=? WHERE id=?", posted.id, id)
}
statusActions.get('/api/v1/scheduled_statuses', async (c) => {
	await authenticate(c, 'read:statuses')
	return c.json(
		await Promise.all(
			(
				await all<ScheduledRow>(
					c.env,
					"SELECT * FROM scheduled_statuses WHERE account_id=? AND state='pending' ORDER BY scheduled_at",
					c.get('account').id
				)
			).map((s) => scheduledJSON(c.env, s))
		)
	)
})
statusActions.get('/api/v1/scheduled_statuses/:id', async (c) => {
	await authenticate(c, 'read:statuses')
	const s = await one<ScheduledRow>(
		c.env,
		"SELECT * FROM scheduled_statuses WHERE id=? AND account_id=? AND state='pending'",
		c.req.param('id'),
		c.get('account').id
	)
	if (!s) throw new ApiError(404, 'Record not found')
	return c.json(await scheduledJSON(c.env, s))
})
statusActions.put('/api/v1/scheduled_statuses/:id', async (c) => {
	await authenticate(c, 'write:statuses')
	const s = await one<ScheduledRow>(
		c.env,
		"SELECT * FROM scheduled_statuses WHERE id=? AND account_id=? AND state='pending'",
		c.req.param('id'),
		c.get('account').id
	)
	if (!s) throw new ApiError(404, 'Record not found')
	const at = Date.parse(stringField(await readInput(c.req.raw), 'scheduled_at'))
	if (!Number.isFinite(at) || at < Date.now() + 300000) throw new ApiError(422, 'Schedule at least five minutes ahead')
	const result = await c.env.DB.batch([
		c.env.DB.prepare(
			"UPDATE scheduled_statuses SET scheduled_at=?,generation=generation+1 WHERE id=? AND state='pending'"
		).bind(new Date(at).toISOString(), s.id),
		c.env.DB.prepare(
			"INSERT INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'schedule.publish',?,?,? WHERE EXISTS(SELECT 1 FROM scheduled_statuses WHERE id=? AND state='pending' AND scheduled_at=?)"
		).bind(
			'schedule:' + s.id + ':' + crypto.randomUUID(),
			JSON.stringify({ scheduleId: s.id }),
			at,
			Date.now(),
			s.id,
			new Date(at).toISOString()
		),
	])
	if (!result[0]?.meta.changes) throw new ApiError(409, 'The scheduled post was already published or cancelled')
	return c.json(await scheduledJSON(c.env, { ...s, scheduled_at: new Date(at).toISOString() }))
})
statusActions.delete('/api/v1/scheduled_statuses/:id', async (c) => {
	await authenticate(c, 'write:statuses')
	const s = await one<ScheduledRow>(
		c.env,
		"SELECT * FROM scheduled_statuses WHERE id=? AND account_id=? AND state='pending'",
		c.req.param('id'),
		c.get('account').id
	)
	if (!s) throw new ApiError(404, 'Record not found')
	const result = await c.env.DB.batch([
		c.env.DB.prepare("UPDATE scheduled_statuses SET state='cancelled' WHERE id=? AND state='pending'").bind(s.id),
		c.env.DB.prepare(
			"UPDATE media_attachments SET scheduled_id=NULL WHERE scheduled_id=? AND EXISTS(SELECT 1 FROM scheduled_statuses WHERE id=? AND state='cancelled')"
		).bind(s.id, s.id),
		c.env.DB.prepare("UPDATE jobs SET state='done',completed_at=? WHERE id=?").bind(Date.now(), 'schedule:' + s.id),
	])
	if (!result[0]?.meta.changes) throw new ApiError(409, 'The scheduled post was already published or cancelled')
	return c.json({})
})
