import { accountDomain } from './identity'
import { Hono } from 'hono'
import { requireAdmin, auditStatement } from './admin'
import { all, one, run, parsed, list, object, now, setting, type Bind } from './data'
import { ApiError, readInput, stringField } from './http'
import type { AppEnv, Env } from './types'
import { VERSION } from './instance'
export const metrics = new Hono<AppEnv>()
function range(input: Record<string, unknown>) {
	const end = new Date(String(input.end_at ?? now())),
		start = new Date(String(input.start_at ?? new Date(Date.now() - 7 * 86400000).toISOString()))
	if (!Number.isFinite(+start) || !Number.isFinite(+end) || +end < +start) throw new ApiError(422, 'Invalid date range')
	start.setUTCHours(0, 0, 0, 0)
	end.setUTCHours(0, 0, 0, 0)
	if (+end - +start > 366 * 86400000) throw new ApiError(422, 'Date range exceeds one year')
	return { start, end, after: new Date(+end + 86400000) }
}
const measureKeys = [
	'active_users',
	'new_users',
	'interactions',
	'opened_reports',
	'resolved_reports',
	'tag_accounts',
	'tag_uses',
	'tag_servers',
	'instance_accounts',
	'instance_media_attachments',
	'instance_reports',
	'instance_statuses',
	'instance_follows',
	'instance_followers',
]
async function measure(env: Env, key: string, start: string, end: string, params: Record<string, unknown>) {
	let from = 'statuses s JOIN accounts a ON a.id=s.account_id',
		date = 's.created_at',
		where = '1=1',
		value = 'COUNT(*)',
		binds: Bind[] = []
	if (key === 'active_users') {
		from = 'activity_metrics m'
		date = "m.day||'T00:00:00.000Z'"
		where = "m.kind='active'"
		value = 'COUNT(DISTINCT m.account_id)'
	}
	if (key === 'new_users' || key === 'instance_accounts') {
		from = 'accounts a'
		date = 'a.created_at'
		where = key === 'new_users' ? "a.domain=''" : 'a.domain=?'
		if (key === 'instance_accounts') binds.push(stringField(params, 'domain'))
	}
	if (key === 'interactions') {
		from = 'interactions i'
		date = 'i.created_at'
		where = "i.kind='favourite'"
	}
	if (key.includes('reports')) {
		from = 'reports r JOIN accounts a ON a.id=r.target_account_id'
		date = key === 'resolved_reports' ? 'r.updated_at' : 'r.created_at'
		where = key === 'resolved_reports' ? 'r.action_taken=1' : key === 'instance_reports' ? 'a.domain=?' : '1=1'
		if (key === 'instance_reports') binds.push(stringField(params, 'domain'))
	}
	if (key.startsWith('tag_')) {
		from += ' JOIN status_tags t ON t.status_id=s.id'
		where = "t.tag=? AND s.visibility='public' AND s.deleted_at IS NULL"
		binds.push(stringField(params, 'id').toLowerCase())
		value =
			key === 'tag_accounts'
				? 'COUNT(DISTINCT s.account_id)'
				: key === 'tag_servers'
					? 'COUNT(DISTINCT a.domain)'
					: 'COUNT(*)'
	}
	if (key === 'instance_statuses') {
		where = 'a.domain=? AND s.deleted_at IS NULL'
		binds.push(stringField(params, 'domain'))
	}
	if (key === 'instance_media_attachments') {
		from = 'media_attachments m JOIN accounts a ON a.id=m.account_id'
		date = "strftime('%Y-%m-%dT%H:%M:%fZ',m.created_at/1000,'unixepoch')"
		where = 'a.domain=?'
		binds.push(stringField(params, 'domain'))
		value = 'COALESCE(SUM(m.bytes),0)'
	}
	if (key === 'instance_follows' || key === 'instance_followers') {
		from = `follows f JOIN accounts a ON a.id=f.${key === 'instance_follows' ? 'following_id' : 'follower_id'} JOIN accounts local ON local.id=f.${key === 'instance_follows' ? 'follower_id' : 'following_id'}`
		date = 'f.created_at'
		where = "a.domain=? AND local.domain='' AND f.state='accepted'"
		binds.push(stringField(params, 'domain'))
	}
	const rows = await all<{ date: string; n: number }>(
		env,
		`SELECT substr(${date},1,10) date,${value} n FROM ${from} WHERE ${where} AND ${date}>=? AND ${date}<? GROUP BY substr(${date},1,10) ORDER BY date`,
		...binds,
		start,
		end
	)
	return rows
}
metrics.post('/api/v1/admin/measures', async (c) => {
	await requireAdmin(c, 'admin:read')
	const input = await readInput(c.req.raw),
		r = range(input),
		keys = list(input.keys, 20).filter((k) => measureKeys.includes(k)),
		result = []
	for (const key of keys) {
		const params = input[key] ? object(input[key]) : {},
			rows = await measure(c.env, key, r.start.toISOString(), r.after.toISOString(), params),
			previous = await measure(
				c.env,
				key,
				new Date(+r.start - (+r.after - +r.start)).toISOString(),
				r.start.toISOString(),
				params
			),
			days = []
		for (let date = +r.start; date < +r.after; date += 86400000) {
			const iso = new Date(date).toISOString()
			days.push({ date: iso, value: String(rows.find((d) => d.date === iso.slice(0, 10))?.n ?? 0) })
		}
		result.push({
			key,
			unit: key === 'instance_media_attachments' ? 'bytes' : null,
			total: String(rows.reduce((n, d) => n + d.n, 0)),
			previous_total: String(previous.reduce((n, d) => n + d.n, 0)),
			data: days,
		})
	}
	return c.json(result)
})
metrics.post('/api/v1/admin/dimensions', async (c) => {
	await requireAdmin(c, 'admin:read')
	const input = await readInput(c.req.raw),
		r = range(input),
		keys = list(input.keys, 20),
		limit = Math.max(1, Math.min(100, Number(input.limit) || 10)),
		result = []
	for (const key of keys) {
		const params = input[key] ? object(input[key]) : {}
		if (key === 'software_versions') {
			const sqlite = await one<{ v: string }>(c.env, 'SELECT sqlite_version() v')
			result.push({
				key,
				data: [
					{ key: 'hyena', human_key: 'Hyena', value: VERSION, human_value: VERSION },
					{ key: 'sqlite', human_key: 'SQLite / D1', value: sqlite?.v ?? '', human_value: sqlite?.v ?? '' },
				],
			})
			continue
		}
		if (key === 'space_usage') {
			const bytes = (await one<{ n: number }>(c.env, 'SELECT COALESCE(SUM(bytes),0) n FROM media_attachments'))?.n ?? 0
			result.push({
				key,
				data: [
					{
						key: 'media',
						human_key: 'Media bytes',
						value: String(bytes),
						unit: 'bytes',
						human_value: (bytes / 1048576).toFixed(1) + ' MiB',
					},
				],
			})
			continue
		}
		let from = 'statuses s JOIN accounts a ON a.id=s.account_id',
			group = key.includes('languages')
				? "COALESCE(s.language,'und')"
				: key === 'sources'
					? "COALESCE(app.name,'Unknown')"
					: key === 'instance_accounts'
						? 'a.username'
						: 'a.domain',
			where = 's.deleted_at IS NULL AND s.created_at>=? AND s.created_at<?',
			binds: Bind[] = [r.start.toISOString(), r.after.toISOString()]
		if (key === 'sources') from += ' LEFT JOIN oauth_apps app ON app.id=s.application_id'
		if (key.startsWith('tag_')) {
			from += ' JOIN status_tags t ON t.status_id=s.id'
			where += ' AND t.tag=?'
			binds.push(stringField(params, 'id').toLowerCase())
		}
		if (key.startsWith('instance_')) {
			where += ' AND a.domain=?'
			binds.push(stringField(params, 'domain'))
		}
		if (
			![
				'languages',
				'sources',
				'servers',
				'tag_servers',
				'tag_languages',
				'instance_accounts',
				'instance_languages',
			].includes(key)
		)
			continue
		const rows = await all<{ key: string; n: number }>(
			c.env,
			`SELECT ${group} key,COUNT(*) n FROM ${from} WHERE ${where} GROUP BY ${group} ORDER BY n DESC LIMIT ?`,
			...binds,
			limit
		)
		result.push({
			key,
			data: rows.map((d) => ({
				key: d.key,
				human_key: d.key || accountDomain(c.env),
				value: String(d.n),
			})),
		})
	}
	return c.json(result)
})
metrics.post('/api/v1/admin/retention', async (c) => {
	await requireAdmin(c, 'admin:read')
	const input = await readInput(c.req.raw),
		r = range(input),
		frequency = input.frequency === 'month' ? 'month' : 'day',
		periods: Date[] = []
	let date = new Date(Math.max(+r.start, +r.end - (frequency === 'month' ? 366 : 31) * 86400000))
	if (frequency === 'month') date.setUTCDate(1)
	while (+date <= +r.end) {
		periods.push(new Date(date))
		if (frequency === 'month') date.setUTCMonth(date.getUTCMonth() + 1)
		else date.setUTCDate(date.getUTCDate() + 1)
	}
	const accounts = await all<{ id: string; created_at: string; last_seen_at: string | null }>(
		c.env,
		"SELECT id,created_at,last_seen_at FROM accounts WHERE domain='' AND created_at>=? AND created_at<?",
		periods[0]?.toISOString() ?? r.start.toISOString(),
		r.after.toISOString()
	)
	const activity = await all<{ account_id: string; day: string }>(
		c.env,
		"SELECT account_id,day FROM activity_metrics WHERE kind='active' AND day>=? AND day<?",
		r.start.toISOString().slice(0, 10),
		r.after.toISOString().slice(0, 10)
	)
	return c.json(
		periods.map((p, i) => {
			const end = periods[i + 1] ?? r.after,
				cohort = accounts.filter((a) => a.created_at >= p.toISOString() && a.created_at < end.toISOString())
			return {
				period: p.toISOString(),
				frequency,
				data: periods.slice(i).map((d) => {
					const next = periods[periods.indexOf(d) + 1] ?? r.after
					const active = new Set(
						activity
							.filter((x) => x.day >= d.toISOString().slice(0, 10) && x.day < next.toISOString().slice(0, 10))
							.map((x) => x.account_id)
					)
					const value = cohort.filter(
						(a) => active.has(a.id) || (a.created_at >= d.toISOString() && a.created_at < next.toISOString())
					).length
					return { date: d.toISOString(), value: String(value), rate: value / Math.max(1, cohort.length) }
				}),
			}
		})
	)
})
metrics.get('/api/hyena/admin/health', async (c) => {
	await requireAdmin(c, 'admin:read')
	return c.json({
		version: VERSION,
		jobs: await all(
			c.env,
			'SELECT kind,state,COUNT(*) count,MIN(created_at) oldest,MAX(attempt) attempts FROM jobs GROUP BY kind,state'
		),
		media: await all(
			c.env,
			'SELECT state,COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM media_attachments GROUP BY state'
		),
		accounts: await all(c.env, "SELECT domain='',COUNT(*) count FROM accounts GROUP BY domain=''"),
		bindings: { images: !!c.env.IMAGES, media: !!c.env.MEDIA, email: !!c.env.EMAIL, translation: !!c.env.TRANSLATION },
		signing_key_configured: !!c.env.KEY_ENCRYPTION_SECRET,
	})
})
metrics.get('/api/hyena/admin/jobs', async (c) => {
	await requireAdmin(c, 'admin:read')
	return c.json(
		await all(
			c.env,
			"SELECT id,kind,state,attempt,available_at,last_error,created_at FROM jobs WHERE state='dead' OR (state IN ('pending','queued','processing') AND last_error IS NOT NULL) ORDER BY CASE WHEN state='dead' THEN 0 ELSE 1 END,created_at DESC LIMIT 100"
		)
	)
})
metrics.post('/api/hyena/admin/jobs/:id/retry', async (c) => {
	const a = await requireAdmin(c, 'admin:write')
	if (
		!(
			await run(
				c.env,
				"UPDATE jobs SET state='pending',attempt=0,first_attempt_at=NULL,available_at=?,lease_token=NULL,lease_until=NULL,dispatch_until=NULL,last_error=NULL WHERE id=? AND state='dead'",
				Date.now(),
				c.req.param('id')
			)
		).meta.changes
	)
		throw new ApiError(409, 'Only failed jobs can be retried')
	await run(
		c.env,
		"UPDATE media_attachments SET state='uploaded',error=NULL WHERE id=(SELECT json_extract(payload,'$.mediaId') FROM jobs WHERE id=? AND kind='media.process') AND state='failed'",
		c.req.param('id')
	)
	await auditStatement(c.env, a.id, 'job.retry', c.req.param('id')).run()
	return c.json({})
})
metrics.get('/api/hyena/admin/settings', async (c) => {
	await requireAdmin(c, 'admin:read', true)
	return c.json(
		Object.fromEntries(
			(
				await all<{ key: string; value: string }>(c.env, "SELECT key,value FROM settings WHERE key NOT IN ('vapid')")
			).map((r) => [r.key, JSON.parse(r.value)])
		)
	)
})
metrics.put('/api/hyena/admin/settings', async (c) => {
	const a = await requireAdmin(c, 'admin:write', true),
		input = await readInput(c.req.raw),
		allowed = [
			'extended_description',
			'privacy_policy',
			'terms_of_service',
			'languages',
			'wrapstodon',
			'limited_federation',
			'donation_campaign',
			'monthly_media_bytes',
			'monthly_image_transforms',
			'monthly_media_seconds',
			'max_accounts',
		]
	for (const [k, v] of Object.entries(input)) {
		if (!allowed.includes(k)) throw new ApiError(422, 'Unknown setting: ' + k)
		if (k.startsWith('monthly_') || k === 'max_accounts') {
			if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 1e12)
				throw new ApiError(422, 'Use a nonnegative integer for ' + k)
		} else if (['wrapstodon', 'limited_federation'].includes(k)) {
			if (typeof v !== 'boolean') throw new ApiError(422, 'Use a boolean for ' + k)
		} else if (k === 'languages') {
			if (
				!Array.isArray(v) ||
				v.length > 100 ||
				v.some((l) => typeof l !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(l))
			)
				throw new ApiError(422, 'Invalid instance languages')
		} else if (k !== 'donation_campaign' && (typeof v !== 'string' || v.length > 50000))
			throw new ApiError(422, 'Invalid text setting ' + k)
	}
	await c.env.DB.batch([
		...Object.entries(input).map(([k, v]) =>
			c.env.DB.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(
				k,
				JSON.stringify(v)
			)
		),
		c.env.DB.prepare(
			"INSERT INTO settings VALUES('policy_updated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
		).bind(JSON.stringify(now())),
		auditStatement(c.env, a.id, 'settings.update', null, { keys: Object.keys(input) }),
	])
	return c.json(input)
})
metrics.put('/api/hyena/admin/rules', async (c) => {
	const a = await requireAdmin(c, 'admin:write', true),
		input = await readInput(c.req.raw)
	if (!Array.isArray(input.rules) || input.rules.length > 50) throw new ApiError(422, 'Use up to 50 rules')
	const rows = input.rules.map((v, i) => {
		const r = object(v),
			text = stringField(r, 'text'),
			hint = stringField(r, 'hint')
		if (!text || text.length > 1000 || hint.length > 2000) throw new ApiError(422, 'Invalid rule')
		return { id: String(i + 1), text, hint, position: i }
	})
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM instance_rules'),
		...rows.map((r) =>
			c.env.DB.prepare('INSERT INTO instance_rules VALUES(?,?,?,?)').bind(r.id, r.text, r.hint, r.position)
		),
		auditStatement(c.env, a.id, 'rules.update', null),
	])
	return c.json(rows)
})
