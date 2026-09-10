import { Hono } from 'hono'
import { validatePublicUrl } from '@fedify/vocab-runtime'
import { authenticate, optionalAccount } from './auth/access'
import { requireAdmin, auditStatement } from './admin'
import { all, one, run, parsed, now, accountById, setting, pageLimit, list, object } from './data'
import { nextId } from './db'
import { ApiError, readInput, stringField, boolField, escapeHtml, boundedBytes } from './http'
import { accountJSON, statusJSON, emojiJSON, pollJSON, mediaJSON } from './serializers'
import { audienceSQL } from './policy'
import { requireStatus } from './status-actions'
import { tagJSON } from './organize'
import { cleanHtml } from './federation/receive'
import { campaign } from './instance'
import type { AppEnv, Env, StatusRow, MediaRow } from './types'
import { page } from './views'
import { limitedAccountSQL } from './moderation-policy'
import { trendHistory } from './trend-history'

export const community = new Hono<AppEnv>()
interface Announcement {
	id: string
	content: string
	starts_at: string | null
	ends_at: string | null
	all_day: number
	published_at: string
	updated_at: string
}
async function announcementJSON(env: Env, a: Announcement, viewer: string | null) {
	const reactions = await all<{ name: string; count: number; me: number }>(
		env,
		'SELECT name,COUNT(*) count,MAX(account_id=?) me FROM announcement_reactions WHERE announcement_id=? GROUP BY name',
		viewer,
		a.id
	)
	return {
		...a,
		all_day: !!a.all_day,
		...(viewer
			? {
					read: !!(await one(
						env,
						'SELECT 1 FROM announcement_reads WHERE account_id=? AND announcement_id=?',
						viewer,
						a.id
					)),
				}
			: {}),
		mentions: [],
		statuses: [],
		tags: [],
		emojis: await emojiJSON(env, a.content),
		reactions: await Promise.all(
			reactions.map(async (r) => {
				const emoji = await one<{ url: string; static_url: string }>(
					env,
					'SELECT url,static_url FROM custom_emojis WHERE shortcode=?',
					r.name
				)
				return { name: r.name, count: r.count, me: !!r.me, ...(emoji ?? {}) }
			})
		),
	}
}
community.get('/api/v1/custom_emojis', async (c) =>
	c.json(
		(
			await all<{ shortcode: string; url: string; static_url: string; visible: number; category: string | null }>(
				c.env,
				'SELECT * FROM custom_emojis ORDER BY shortcode'
			)
		).map((e) => ({
			shortcode: e.shortcode,
			url: e.url,
			static_url: e.static_url,
			visible_in_picker: !!e.visible,
			...(e.category ? { category: e.category } : {}),
		}))
	)
)
community.get('/api/v1/announcements', async (c) => {
	const viewer = await optionalAccount(c)
	const rows = await all<Announcement>(
		c.env,
		`SELECT * FROM announcements a WHERE published_at<=? AND (ends_at IS NULL OR ends_at>?) ${c.req.query('with_dismissed') === 'true' || !viewer ? '' : 'AND NOT EXISTS(SELECT 1 FROM announcement_reads r WHERE r.account_id=? AND r.announcement_id=a.id)'} ORDER BY published_at DESC`,
		now(),
		now(),
		...(c.req.query('with_dismissed') === 'true' || !viewer ? [] : [viewer])
	)
	return c.json(await Promise.all(rows.map((a) => announcementJSON(c.env, a, viewer))))
})
community.post('/api/v1/announcements/:id/dismiss', async (c) => {
	await authenticate(c, 'write:accounts')
	const id = c.req.param('id')
	if (!(await one(c.env, 'SELECT 1 FROM announcements WHERE id=?', id))) throw new ApiError(404, 'Record not found')
	await run(c.env, 'INSERT OR IGNORE INTO announcement_reads VALUES(?,?)', c.get('account').id, id)
	return c.json({})
})
for (const method of ['put', 'delete'] as const)
	community[method]('/api/v1/announcements/:id/reactions/:name', async (c) => {
		await authenticate(c, 'write:accounts')
		const id = c.req.param('id'),
			name = c.req.param('name')
		if (!(await one(c.env, 'SELECT 1 FROM announcements WHERE id=?', id))) throw new ApiError(404, 'Record not found')
		if (
			!name ||
			([...new Intl.Segmenter().segment(name)].length !== 1 &&
				!(await one(c.env, 'SELECT 1 FROM custom_emojis WHERE shortcode=?', name))) ||
			name.length > 100
		)
			throw new ApiError(422, 'Use an emoji reaction')
		if (
			!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(name) &&
			!(await one(c.env, 'SELECT 1 FROM custom_emojis WHERE shortcode=?', name))
		)
			throw new ApiError(422, 'Use an emoji reaction')
		await run(
			c.env,
			method === 'put'
				? 'INSERT OR IGNORE INTO announcement_reactions VALUES(?,?,?)'
				: 'DELETE FROM announcement_reactions WHERE account_id=? AND announcement_id=? AND name=?',
			c.get('account').id,
			id,
			name
		)
		await broadcast(envOf(c), 'announcement.reaction', {
			announcement_id: id,
			name,
			count:
				(
					await one<{ n: number }>(
						c.env,
						'SELECT COUNT(*) n FROM announcement_reactions WHERE announcement_id=? AND name=?',
						id,
						name
					)
				)?.n ?? 0,
		})
		return c.json({})
	})
function envOf(c: { env: Env }) {
	return c.env
}
async function broadcast(env: Env, event: string, payload: unknown) {
	for (const a of await all<{ id: string }>(
		env,
		"SELECT id FROM accounts WHERE domain='' AND disabled=0 AND suspended=0"
	))
		await env.STREAMS.get(env.STREAMS.idFromName(a.id)).sendEvent(event, JSON.stringify(payload))
}
// These operator extensions manage the same entities exposed by the Mastodon API.
community.post('/api/hyena/admin/announcements', async (c) => {
	const a = await requireAdmin(c, 'admin:write'),
		input = await readInput(c.req.raw),
		content = stringField(input, 'content'),
		id = await nextId(c.env.DB)
	if (!content || content.length > 10000) throw new ApiError(422, 'Announcement must contain 1–10000 characters')
	const start = stringField(input, 'starts_at') || null,
		end = stringField(input, 'ends_at') || null
	if ((start && !Number.isFinite(Date.parse(start))) || (end && !Number.isFinite(Date.parse(end))))
		throw new ApiError(422, 'Invalid announcement dates')
	await c.env.DB.batch([
		c.env.DB.prepare('INSERT INTO announcements VALUES(?,?,?,?,?,?,?)').bind(
			id,
			cleanHtml(content),
			start,
			end,
			+boolField(input, 'all_day'),
			now(),
			now()
		),
		auditStatement(c.env, a.id, 'announcement.create', id),
	])
	const row = (await one<Announcement>(c.env, 'SELECT * FROM announcements WHERE id=?', id))!
	await broadcast(c.env, 'announcement', await announcementJSON(c.env, row, null))
	return c.json(await announcementJSON(c.env, row, a.id))
})
community.delete('/api/hyena/admin/announcements/:id', async (c) => {
	const a = await requireAdmin(c, 'admin:write')
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM announcements WHERE id=?').bind(c.req.param('id')),
		auditStatement(c.env, a.id, 'announcement.delete', c.req.param('id')),
	])
	await broadcast(c.env, 'announcement.delete', c.req.param('id'))
	return c.json({})
})
community.post('/api/hyena/admin/custom_emojis', async (c) => {
	const a = await requireAdmin(c, 'admin:write'),
		input = await readInput(c.req.raw),
		shortcode = stringField(input, 'shortcode'),
		m = await one<MediaRow>(
			c.env,
			"SELECT * FROM media_attachments WHERE id=? AND account_id=? AND state='ready' AND media_type='image'",
			stringField(input, 'media_id'),
			a.id
		)
	if (!/^[A-Za-z0-9_]{2,64}$/.test(shortcode) || !m)
		throw new ApiError(422, 'A shortcode and a processed image are required')
	const media = mediaJSON(c.env, m),
		id = await nextId(c.env.DB)
	await c.env.DB.batch([
		c.env.DB.prepare(
			'INSERT INTO custom_emojis(id,shortcode,url,static_url,category,visible) VALUES(?,?,?,?,?,?) ON CONFLICT(shortcode) DO UPDATE SET url=excluded.url,static_url=excluded.static_url,category=excluded.category,visible=excluded.visible'
		).bind(
			id,
			shortcode,
			media.url!,
			media.preview_url || media.url!,
			stringField(input, 'category') || null,
			+boolField(input, 'visible_in_picker', true)
		),
		auditStatement(c.env, a.id, 'emoji.upsert', shortcode),
	])
	return c.json({
		shortcode,
		url: media.url,
		static_url: media.preview_url || media.url,
		visible_in_picker: boolField(input, 'visible_in_picker', true),
	})
})
community.delete('/api/hyena/admin/custom_emojis/:shortcode', async (c) => {
	const a = await requireAdmin(c, 'admin:write')
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM custom_emojis WHERE shortcode=?').bind(c.req.param('shortcode')),
		auditStatement(c.env, a.id, 'emoji.delete', c.req.param('shortcode')),
	])
	return c.json({})
})

async function trendItems(env: Env, kind: string, viewer: string | null, limit: number, review = false) {
	const discovery = audienceSQL(viewer, 's')
	if (kind === 'tags') {
		const rows = await all<{ name: string; approved: number; usable: number; listable: number }>(
			env,
			`SELECT t.* FROM tags t JOIN status_tags st ON st.tag=t.name JOIN statuses s ON s.id=st.status_id JOIN accounts a ON a.id=s.account_id WHERE s.visibility='public' AND s.created_at>? AND ${discovery.sql} AND NOT ${limitedAccountSQL()} ${review ? '' : 'AND t.approved=1 AND t.listable=1'} GROUP BY t.name ORDER BY COUNT(DISTINCT s.account_id) DESC LIMIT ?`,
			new Date(Date.now() - 7 * 86400000).toISOString(),
			...discovery.binds,
			limit
		)
		return Promise.all(
			rows.map(async (r) => ({
				...(await tagJSON(env, r.name, viewer)),
				...(review
					? {
							id: r.name,
							requires_review: !r.approved,
							usable: !!r.usable,
							listable: !!r.listable,
							trendable: !!r.approved,
						}
					: {}),
			}))
		)
	}
	if (kind === 'links') {
		const rows = await all<{ url: string; data: string; approved: number }>(
			env,
			`SELECT l.* FROM link_cards l JOIN statuses s ON json_extract(s.card,'$.url')=l.url JOIN accounts a ON a.id=s.account_id WHERE s.created_at>? AND s.visibility='public' AND s.reblog_of_id IS NULL AND ${discovery.sql} AND NOT ${limitedAccountSQL()} ${review ? '' : 'AND l.approved=1'} GROUP BY l.url ORDER BY COUNT(DISTINCT s.account_id) DESC,COUNT(*) DESC LIMIT ?`,
			new Date(Date.now() - 7 * 86400000).toISOString(),
			...discovery.binds,
			limit
		)
		return Promise.all(
			rows.map(async (r) => ({
				...parsed<Record<string, unknown>>(r.data, {}),
				history: await trendHistory(env, viewer, "json_extract(s.card,'$.url')=?", [r.url]),
				...(review ? { id: r.url, requires_review: !r.approved } : {}),
			}))
		)
	}
	if (kind === 'publishers') {
		const rows = await all<{ url: string }>(env, 'SELECT url FROM link_cards ORDER BY fetched_at DESC LIMIT 1000'),
			hosts = [...new Set(rows.map((r) => new URL(r.url).host))].slice(0, limit)
		return Promise.all(
			hosts.map(async (host) => ({
				id: host,
				domain: host,
				icon: '',
				trendable: !!(
					await one<{ approved: number }>(
						env,
						"SELECT approved FROM trend_reviews WHERE kind='publishers' AND item_id=?",
						host
					)
				)?.approved,
				requires_review: !(await one(env, "SELECT 1 FROM trend_reviews WHERE kind='publishers' AND item_id=?", host)),
			}))
		)
	}
	const policy = audienceSQL(viewer, 's'),
		rows = await all<StatusRow>(
			env,
			`SELECT s.* FROM statuses s ${review ? '' : "JOIN trend_reviews tr ON tr.item_id=s.id AND tr.kind='statuses' AND tr.approved=1"} WHERE s.visibility='public' AND s.reblog_of_id IS NULL AND s.created_at>? AND ${policy.sql} ORDER BY (SELECT COUNT(*) FROM interactions i WHERE i.status_id=s.id AND i.kind='favourite')+(SELECT COUNT(*) FROM statuses b WHERE b.reblog_of_id=s.id AND b.deleted_at IS NULL) DESC,s.sequence DESC LIMIT ?`,
			new Date(Date.now() - 7 * 86400000).toISOString(),
			...policy.binds,
			limit
		)
	return Promise.all(
		rows.map(async (s) => ({
			...(await statusJSON(env, s, viewer)),
			...(review
				? {
						requires_review: !(await one(env, "SELECT 1 FROM trend_reviews WHERE kind='statuses' AND item_id=?", s.id)),
					}
				: {}),
		}))
	)
}
community.get('/api/v1/trends', async (c) =>
	c.json(await trendItems(c.env, 'tags', await optionalAccount(c), pageLimit(c, 20, 10)))
)
for (const kind of ['tags', 'links', 'statuses', 'publishers']) {
	if (kind !== 'publishers')
		community.get('/api/v1/trends/' + kind, async (c) =>
			c.json(await trendItems(c.env, kind, await optionalAccount(c), pageLimit(c, 40, 10)))
		)
	const path = '/api/v1/admin/trends/' + (kind === 'publishers' ? 'links/publishers' : kind)
	community.get(path, async (c) => {
		const a = await requireAdmin(c, 'admin:read')
		return c.json(await trendItems(c.env, kind, a.id, pageLimit(c, 100), true))
	})
	for (const action of ['approve', 'reject'])
		community.post(path + '/:id/' + action, async (c) => {
			const a = await requireAdmin(c, 'admin:write'),
				id = c.req.param('id')!,
				approved = +(action === 'approve')
			const statements = [
				c.env.DB.prepare(
					'INSERT INTO trend_reviews VALUES(?,?,?,?) ON CONFLICT(kind,item_id) DO UPDATE SET approved=excluded.approved,updated_at=excluded.updated_at'
				).bind(kind, id, approved, now()),
				auditStatement(c.env, a.id, `trend.${kind}.${action}`, id),
			]
			if (kind === 'tags')
				statements.push(c.env.DB.prepare('UPDATE tags SET approved=? WHERE name=?').bind(approved, id))
			if (kind === 'publishers')
				statements.push(
					c.env.DB.prepare("UPDATE link_cards SET approved=? WHERE json_extract(data,'$.provider_url') IN (?,?)").bind(
						approved,
						'https://' + id,
						'http://' + id
					)
				)
			if (kind === 'links')
				statements.push(c.env.DB.prepare('UPDATE link_cards SET approved=? WHERE url=?').bind(approved, id))
			await c.env.DB.batch(statements)
			return c.json({ id, trendable: !!approved, requires_review: false })
		})
}
community.get('/api/v1/admin/tags', async (c) => {
	await requireAdmin(c, 'admin:read')
	return c.json(
		await all(
			c.env,
			'SELECT name AS id,name,approved AS trendable,usable,listable FROM tags ORDER BY name LIMIT ?',
			pageLimit(c, 200)
		)
	)
})
community.get('/api/v1/admin/tags/:id', async (c) => {
	await requireAdmin(c, 'admin:read')
	const t = await one(
		c.env,
		'SELECT name AS id,name,approved AS trendable,usable,listable FROM tags WHERE name=?',
		c.req.param('id')
	)
	if (!t) throw new ApiError(404, 'Record not found')
	return c.json(t)
})
community.put('/api/v1/admin/tags/:id', async (c) => {
	const a = await requireAdmin(c, 'admin:write'),
		t = await one<{ approved: number; usable: number; listable: number }>(
			c.env,
			'SELECT * FROM tags WHERE name=?',
			c.req.param('id')
		)
	if (!t) throw new ApiError(404, 'Record not found')
	const input = await readInput(c.req.raw)
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE tags SET approved=?,usable=?,listable=? WHERE name=?').bind(
			+boolField(input, 'trendable', !!t.approved),
			+boolField(input, 'usable', !!t.usable),
			+boolField(input, 'listable', !!t.listable),
			c.req.param('id')
		),
		auditStatement(c.env, a.id, 'tag.update', c.req.param('id')),
	])
	return c.json({ ...(await tagJSON(c.env, c.req.param('id'), a.id)), id: c.req.param('id') })
})

community.post('/api/v1/statuses/:id/translate', async (c) => {
	await authenticate(c, 'read:statuses')
	const a = c.get('account'),
		s = await requireStatus(c.env, c.req.param('id'), a.id)
	if (!c.env.TRANSLATION) throw new ApiError(403, 'Translation is not enabled')
	if (!['public', 'unlisted'].includes(s.visibility))
		throw new ApiError(403, 'Only public or unlisted posts can be translated')
	const input = await readInput(c.req.raw),
		language = stringField(input, 'lang', parsed<{ locale?: string }>(a.preferences, {}).locale ?? 'en')
	if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) throw new ApiError(422, 'Invalid target language')
	const p = await pollJSON(c.env, s.id, a.id),
		media = await all<MediaRow>(c.env, 'SELECT * FROM media_attachments WHERE status_id=? ORDER BY position', s.id),
		response = await c.env.TRANSLATION.fetch('https://translation.internal/translate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: s.content,
				spoiler_text: s.spoiler_text,
				source_language: s.language,
				language,
				poll: p ? { id: p.id, options: p.options.map((o) => ({ title: o.title })) } : null,
				media_attachments: media.map((m) => ({ id: m.id, description: m.description })),
			}),
		})
	if (!response.ok) throw new ApiError(503, 'Translation service unavailable')
	const result = object(await response.json())
	if (typeof result.content !== 'string') throw new ApiError(503, 'Translation service returned an invalid response')
	return c.json({
		...result,
		content: cleanHtml(result.content),
		spoiler_text: typeof result.spoiler_text === 'string' ? result.spoiler_text : '',
		language,
		detected_source_language: result.detected_source_language ?? s.language,
		provider: result.provider ?? 'Instance translation service',
		poll: result.poll ?? null,
		media_attachments: result.media_attachments ?? [],
	})
})
community.get('/api/v1/donation_campaigns', async (c) => {
	await authenticate(c, 'read:accounts')
	const active = await setting<Record<string, unknown> | null>(c.env, 'donation_campaign', null)
	return active ? c.json(active) : c.body(null, 204)
})

async function annual(env: Env, accountId: string, year: number) {
	const range = [`${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`],
		counts = await one<{ total: number; standalone: number; replies: number; reblogs: number; polls: number }>(
			env,
			`SELECT COUNT(*) total,SUM(in_reply_to_id IS NULL AND reblog_of_id IS NULL) standalone,SUM(in_reply_to_id IS NOT NULL) replies,SUM(reblog_of_id IS NOT NULL) reblogs,SUM(EXISTS(SELECT 1 FROM polls p WHERE p.status_id=s.id)) polls FROM statuses s WHERE account_id=? AND deleted_at IS NULL AND created_at>=? AND created_at<?`,
			accountId,
			...range
		),
		n = counts!,
		hashtags = await all<{ name: string; count: number }>(
			env,
			'SELECT t.tag name,COUNT(*) count FROM status_tags t JOIN statuses s ON s.id=t.status_id WHERE s.account_id=? AND s.deleted_at IS NULL AND s.created_at>=? AND s.created_at<? GROUP BY tag HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC LIMIT 1',
			accountId,
			...range
		),
		top = async (metric: string) =>
			(
				await one<{ id: string }>(
					env,
					`SELECT s.id FROM statuses s WHERE s.account_id=? AND s.visibility IN ('public','unlisted') AND s.deleted_at IS NULL AND s.created_at>=? AND s.created_at<? ORDER BY ${metric} DESC,s.sequence DESC LIMIT 1`,
					accountId,
					...range
				)
			)?.id ?? null
	const byReblogs = await top('(SELECT COUNT(*) FROM statuses b WHERE b.reblog_of_id=s.id AND b.deleted_at IS NULL)'),
		followers = await all<{ month: number; followers: number }>(
			env,
			"SELECT CAST(strftime('%m',created_at) AS INTEGER) month,COUNT(*) followers FROM follows WHERE following_id=? AND state='accepted' AND created_at>=? AND created_at<? GROUP BY month",
			accountId,
			...range
		)

	return {
		eligible: !!byReblogs && !!hashtags.length,
		data: {
			archetype:
				n.total < 113
					? 'lurker'
					: n.reblogs > n.standalone * 2
						? 'booster'
						: n.polls > n.standalone * 0.1
							? 'pollster'
							: n.replies > n.standalone * 2
								? 'replier'
								: 'oracle',
			top_statuses: { by_reblogs: byReblogs, by_favourites: null, by_replies: null },
			time_series: [
				{ month: 12, statuses: n.total, followers: followers.reduce((total, m) => total + m.followers, 0) },
			],
			top_hashtags: hashtags,
		},
	}
}
type AnnualRow = {
	account_id: string
	year: number
	data: string
	schema_version: number
	share_key: string | null
	read: number
}
async function annualJSON(env: Env, rows: AnnualRow[], viewer: string) {
	const statuses: unknown[] = []
	for (const r of rows) {
		const data = parsed<{ top_statuses: Record<string, string | null> }>(r.data, { top_statuses: {} })
		for (const id of Object.values(data.top_statuses))
			if (id) {
				try {
					statuses.push(await statusJSON(env, await requireStatus(env, id, viewer), viewer))
				} catch {
					/* Deleted or restricted since the report was generated. */
				}
			}
	}
	return {
		annual_reports: rows.map((r) => ({
			year: r.year,
			data: JSON.parse(r.data),
			schema_version: r.schema_version,
			share_url: r.share_key ? `${env.PUBLIC_ORIGIN}/wrapstodon/${r.account_id}/${r.year}/${r.share_key}` : null,
			account_id: r.account_id,
		})),
		accounts: [await accountJSON(env, await accountById(env, viewer))],
		statuses,
	}
}
community.get('/api/v1/annual_reports', async (c) => {
	await authenticate(c, 'read:accounts')
	return c.json(
		await annualJSON(
			c.env,
			await all<AnnualRow>(
				c.env,
				'SELECT * FROM annual_reports WHERE account_id=? AND read=0 ORDER BY year DESC',
				c.get('account').id
			),
			c.get('account').id
		)
	)
})
community.get('/wrapstodon/:account/:year/:key', async (c) => {
	const row = await one<AnnualRow>(
		c.env,
		'SELECT * FROM annual_reports WHERE account_id=? AND year=? AND share_key=?',
		c.req.param('account'),
		Number(c.req.param('year')),
		c.req.param('key')
	)
	if (!row || !(await setting(c.env, 'wrapstodon', true))) throw new ApiError(404, 'Record not found')
	const account = await accountById(c.env, row.account_id)
	if (account.suspended || account.disabled) throw new ApiError(404, 'Record not found')
	const data = parsed<{
		archetype: string
		time_series: { statuses: number; followers: number }[]
		top_hashtags: { name: string; count: number }[]
	}>(row.data, {} as never)
	return c.html(
		page(
			`${account.username} · ${row.year}`,
			`<h1>@${escapeHtml(account.username)} in ${row.year}</h1><p>${escapeHtml(data.archetype)}</p><p>${data.time_series.reduce((n, m) => n + m.statuses, 0)} posts · ${data.time_series.reduce((n, m) => n + m.followers, 0)} new followers</p><p>${data.top_hashtags.map((t) => '#' + escapeHtml(t.name) + ' (' + t.count + ')').join(' · ')}</p><a href="/@${escapeHtml(account.username)}">View profile</a>`
		)
	)
})
community.get('/api/v1/annual_reports/:year', async (c) => {
	await authenticate(c, 'read:accounts')
	const r = await one<AnnualRow>(
		c.env,
		'SELECT * FROM annual_reports WHERE account_id=? AND year=?',
		c.get('account').id,
		Number(c.req.param('year'))
	)
	if (!r) throw new ApiError(404, 'Record not found')
	return c.json(await annualJSON(c.env, [r], c.get('account').id))
})
community.get('/api/v1/annual_reports/:year/state', async (c) => {
	await authenticate(c, 'read:accounts')
	const year = Number(c.req.param('year')),
		a = c.get('account').id
	return c.json({
		state: (await one(c.env, 'SELECT 1 FROM annual_reports WHERE account_id=? AND year=?', a, year))
			? 'available'
			: year === campaign() && (await annual(c.env, a, year)).eligible
				? 'eligible'
				: 'ineligible',
	})
})
community.post('/api/v1/annual_reports/:year/generate', async (c) => {
	await authenticate(c, 'write:accounts')
	const year = Number(c.req.param('year')),
		a = c.get('account').id
	if (
		year !== campaign() ||
		!(await setting(c.env, 'wrapstodon', true)) ||
		(await one(c.env, 'SELECT 1 FROM annual_reports WHERE account_id=? AND year=?', a, year))
	)
		return c.json({})
	const report = await annual(c.env, a, year),
		id = crypto.randomUUID()
	await c.env.DB.batch([
		c.env.DB.prepare('INSERT OR IGNORE INTO annual_reports(account_id,year,data,share_key) VALUES(?,?,?,?)').bind(
			a,
			year,
			JSON.stringify(report.data),
			crypto.randomUUID().replaceAll('-', '')
		),
		c.env.DB.prepare("INSERT INTO async_refreshes VALUES(?,?,'finished',NULL,?)").bind(id, a, now()),
	])
	c.header('Mastodon-Async-Refresh', `${c.env.PUBLIC_ORIGIN}/api/v1_alpha/async_refreshes/${id}`)
	c.header('Retry-After', '2')
	return c.body(null, 202)
})
community.post('/api/v1/annual_reports/:year/read', async (c) => {
	await authenticate(c, 'write:accounts')
	if (
		!(
			await run(
				c.env,
				'UPDATE annual_reports SET read=1 WHERE account_id=? AND year=?',
				c.get('account').id,
				Number(c.req.param('year'))
			)
		).meta.changes
	)
		throw new ApiError(404, 'Record not found')
	return c.json({})
})
community.get('/api/v1_alpha/async_refreshes/:id', async (c) => {
	await authenticate(c, 'read')
	const r = await one<{ id: string; status: string }>(
		c.env,
		'SELECT id,status FROM async_refreshes WHERE id=? AND account_id=?',
		c.req.param('id'),
		c.get('account').id
	)
	if (!r) throw new ApiError(404, 'Record not found')
	return c.json({ async_refresh: { id: r.id, status: r.status, result_count: null } })
})

export async function fetchCard(env: Env, statusId: string) {
	const s = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', statusId)
	if (!s || s.deleted_at || !['public', 'unlisted'].includes(s.visibility)) return
	const match = /https?:\/\/[^\s<>"']+/u.exec(s.text)
	if (!match) return
	let url = new URL(match[0].replace(/[.,!?:;)]+$/, '')),
		response: Response | null = null
	for (let i = 0; i < 4; i++) {
		await validatePublicUrl(url.href)
		response = await fetch(url, {
			redirect: 'manual',
			headers: { 'User-Agent': 'Hyena link preview (+https://github.com/mitchell-johnson/Hyena)', Accept: 'text/html' },
			signal: AbortSignal.timeout(10000),
		})
		if (response.status >= 300 && response.status < 400 && response.headers.get('Location')) {
			url = new URL(response.headers.get('Location')!, url)
			continue
		}
		break
	}
	if (!response?.ok || !response.headers.get('Content-Type')?.includes('text/html')) return
	const html = new TextDecoder().decode(await boundedBytes(response, 2_000_000)),
		meta: Record<string, string> = {}
	let title = ''
	await new HTMLRewriter()
		.on('title', {
			text(t) {
				title += t.text
			},
		})
		.on('meta', {
			element(e) {
				const key = e.getAttribute('property') || e.getAttribute('name'),
					value = e.getAttribute('content')
				if (key && value && value.length < 4096) meta[key] = value
			},
		})
		.transform(new Response(html))
		.text()
	const card = {
		url: url.href,
		title: (meta['og:title'] || title).slice(0, 300),
		description: (meta['og:description'] || meta.description || '').slice(0, 1000),
		type: 'link',
		author_name: meta.author ?? '',
		author_url: '',
		provider_name: meta['og:site_name'] || url.host,
		provider_url: url.origin,
		html: '',
		width: 0,
		height: 0,
		image: null,
		embed_url: '',
		blurhash: null,
		authors: [],
	}
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO link_cards(url,data,fetched_at,approved) VALUES(?,?,?,COALESCE((SELECT approved FROM trend_reviews WHERE kind='publishers' AND item_id=?),0)) ON CONFLICT(url) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
		).bind(url.href, JSON.stringify(card), now(), url.host),
		env.DB.prepare('UPDATE statuses SET card=? WHERE id=? AND deleted_at IS NULL').bind(JSON.stringify(card), s.id),
	])
}
