import { accountDomain } from './identity'
import { Hono } from 'hono'
import { all, one, parsed, setting, now } from './data'
import { accountJSON } from './serializers'
import { maxMediaBytes, MEDIA_TYPES } from './media/process'
import { vapid } from './push'
import { ApiError } from './http'
import type { AccountRow, AppEnv, Env } from './types'

export const VERSION = '0.2.0-alpha.1'
export const instance = new Hono<AppEnv>()
export async function configuration(env: Env) {
	const access = { local: 'public', remote: 'public' }
	return {
		urls: {
			streaming: env.PUBLIC_ORIGIN.replace(/^http/, 'ws'),
			status: null,
			about: env.PUBLIC_ORIGIN + '/about',
			privacy_policy: env.PUBLIC_ORIGIN + '/privacy-policy',
			terms_of_service: env.PUBLIC_ORIGIN + '/terms',
		},
		vapid: { public_key: (await vapid(env)).public },
		accounts: {
			max_display_name_length: 30,
			max_note_length: 500,
			max_avatar_description_length: 1500,
			max_header_description_length: 1500,
			max_featured_tags: 10,
			max_pinned_statuses: 5,
			max_profile_fields: 4,
			profile_field_name_limit: 255,
			profile_field_value_limit: 255,
		},
		statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 },
		media_attachments: {
			description_limit: 1500,
			supported_mime_types: MEDIA_TYPES,
			image_size_limit: Math.min(20_000_000, maxMediaBytes(env)),
			image_matrix_limit: 40_000_000,
			video_size_limit: maxMediaBytes(env),
			video_frame_rate_limit: 60,
			video_matrix_limit: 1920 * 1080,
		},
		polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
		translation: { enabled: !!env.TRANSLATION },
		timelines_access: { live_feeds: access, hashtag_feeds: access, trending_link_feeds: access },
		limited_federation: await setting(env, 'limited_federation', false),
	}
}
export function campaign(date = new Date()) {
	return date.getUTCMonth() === 11 && date.getUTCDate() >= 10 ? date.getUTCFullYear() : null
}
async function details(env: Env) {
	const a = await one<AccountRow>(
		env,
		"SELECT * FROM accounts WHERE domain='' AND role='admin' AND suspended=0 ORDER BY id LIMIT 1"
	)
	const stats = await one<{ user_count: number; status_count: number; domain_count: number; active_month: number }>(
		env,
		`SELECT (SELECT COUNT(*) FROM accounts WHERE domain='' AND approved=1 AND suspended=0) user_count,(SELECT COUNT(*) FROM statuses WHERE local=1 AND deleted_at IS NULL) status_count,(SELECT COUNT(DISTINCT domain) FROM accounts WHERE domain<>'' AND suspended=0) domain_count,(SELECT COUNT(*) FROM accounts WHERE domain='' AND suspended=0 AND COALESCE(last_seen_at,created_at)>?) active_month`,
		new Date(Date.now() - 30 * 86400000).toISOString()
	)
	return {
		a,
		stats: stats!,
		rules: await all(env, 'SELECT id,text,hint FROM instance_rules ORDER BY position,id'),
		configuration: await configuration(env),
		languages: await setting(env, 'languages', ['en']),
	}
}
instance.on('GET', ['/health', '/health/live'], (c) => c.json({ status: 'ok', software: 'hyena', version: VERSION }))
instance.on('GET', ['/ready', '/health/ready'], async (c) => {
	await one(c.env, 'SELECT 1')
	return c.json({ status: 'ok' })
})
instance.get('/api/v2/instance', async (c) => {
	const d = await details(c.env)
	return c.json({
		domain: accountDomain(c.env),
		title: c.env.INSTANCE_TITLE,
		version: VERSION + '+hyena',
		source_url: 'https://github.com/mitchell-johnson/Hyena',
		description: c.env.INSTANCE_DESCRIPTION,
		usage: { users: { active_month: d.stats.active_month } },
		thumbnail: { url: c.env.PUBLIC_ORIGIN + '/avatar.svg', description: c.env.INSTANCE_TITLE },
		icon: [{ src: c.env.PUBLIC_ORIGIN + '/avatar.svg', size: '400x400' }],
		languages: d.languages,
		configuration: d.configuration,
		registrations: {
			enabled: !!c.env.EMAIL && ['open', 'approved'].includes(c.env.REGISTRATIONS ?? ''),
			approval_required: c.env.REGISTRATIONS === 'approved',
			reason_required: c.env.REGISTRATIONS === 'approved',
			message: null,
			min_age: null,
			url: null,
		},
		contact: { email: c.env.CONTACT_EMAIL ?? '', account: d.a ? await accountJSON(c.env, d.a) : null },
		rules: d.rules,
		api_versions: { mastodon: 0 },
		wrapstodon: (await setting(c.env, 'wrapstodon', true)) ? campaign() : null,
		hyena: {
			version: VERSION,
			compatibility_target: 'Mastodon 4.7.1 / API 11',
			compatibility_verified: false,
			max_media_duration_seconds: 60,
			media_duration_exclusive: true,
		},
	})
})
instance.get('/api/v1/instance', async (c) => {
	const d = await details(c.env)
	return c.json({
		uri: accountDomain(c.env),
		title: c.env.INSTANCE_TITLE,
		short_description: c.env.INSTANCE_DESCRIPTION,
		description: await setting(c.env, 'extended_description', c.env.INSTANCE_DESCRIPTION),
		email: c.env.CONTACT_EMAIL ?? '',
		version: VERSION + '+hyena',
		urls: { streaming_api: c.env.PUBLIC_ORIGIN.replace(/^http/, 'ws') },
		stats: d.stats,
		thumbnail: c.env.PUBLIC_ORIGIN + '/avatar.svg',
		languages: d.languages,
		registrations: !!c.env.EMAIL && ['open', 'approved'].includes(c.env.REGISTRATIONS ?? ''),
		approval_required: c.env.REGISTRATIONS === 'approved',
		invites_enabled: true,
		configuration: d.configuration,
		contact_account: d.a ? await accountJSON(c.env, d.a) : null,
		rules: d.rules,
	})
})
instance.get('/api/v1/instance/peers', async (c) =>
	c.json(
		(
			await all<{ domain: string }>(
				c.env,
				"SELECT DISTINCT domain FROM accounts WHERE domain<>'' AND suspended=0 ORDER BY domain LIMIT 10000"
			)
		).map((r) => r.domain)
	)
)
instance.get('/api/v1/peers/search', async (c) => {
	const q = (c.req.query('q') ?? '').toLowerCase()
	if (q.length > 255) throw new ApiError(400, 'Query too long')
	return c.json(
		(
			await all<{ domain: string }>(
				c.env,
				"SELECT DISTINCT domain FROM accounts WHERE domain<>'' AND suspended=0 AND domain LIKE ? ESCAPE '\\' ORDER BY domain LIMIT 20",
				'%' + q.replace(/[\\%_]/g, '\\$&') + '%'
			)
		).map((r) => r.domain)
	)
})
instance.get('/api/v1/instance/rules', async (c) =>
	c.json(await all(c.env, 'SELECT id,text,hint FROM instance_rules ORDER BY position,id'))
)
instance.get('/api/v1/instance/domain_blocks', async (c) => {
	const rows = await all<{ value: string; data: string }>(
		c.env,
		"SELECT value,data FROM moderation_rules WHERE kind='domain_blocks' ORDER BY value"
	)
	return c.json(
		rows.map((r) => {
			const d = parsed<Record<string, unknown>>(r.data, {})
			return {
				domain: d.obfuscate ? r.value.replace(/[^.]/g, '*') : r.value,
				digest: null,
				severity: d.severity ?? 'suspend',
				comment: d.public_comment ?? null,
			}
		})
	)
})
instance.get('/api/v1/instance/extended_description', async (c) =>
	c.json({
		updated_at: await setting(c.env, 'policy_updated_at', null),
		content: await setting(c.env, 'extended_description', c.env.INSTANCE_DESCRIPTION),
	})
)
instance.get('/api/v1/instance/privacy_policy', async (c) =>
	c.json({
		updated_at: await setting(c.env, 'policy_updated_at', null),
		content: await setting(
			c.env,
			'privacy_policy',
			'This instance stores account information, posts, social relationships and uploaded media to provide the service. Public posts and profile information are shared with other servers through ActivityPub. Contact the instance administrator for data export or deletion.'
		),
	})
)
instance.get('/api/v1/instance/terms_of_service', async (c) => c.json(await setting(c.env, 'terms_of_service', [])))
instance.get('/api/v1/instance/terms_of_service/:date', async (c) => {
	const terms = await setting<{ effective_date: string; content: string }[]>(c.env, 'terms_of_service', []),
		row = terms.find((t) => t.effective_date === c.req.param('date'))
	if (!row) throw new ApiError(404, 'Record not found')
	return c.json(row)
})
instance.get('/api/v1/instance/languages', async (c) => {
	const codes = await setting(c.env, 'languages', ['en']),
		names = new Intl.DisplayNames(['en'], { type: 'language' })
	return c.json(
		codes.map((code) => ({
			code,
			name: names.of(code) ?? code,
			native_name: new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code,
		}))
	)
})
instance.get('/api/v1/instance/translation_languages', async (c) => {
	if (!c.env.TRANSLATION) return c.json({})
	const response = await c.env.TRANSLATION.fetch('https://translation.internal/languages')
	if (!response.ok) throw new ApiError(503, 'Translation service unavailable')
	return c.json((await response.json()) as Record<string, string[]>)
})
instance.get('/api/v1/instance/activity', async (c) => {
	const rows = []
	for (let i = 0; i < 12; i++) {
		const end = Date.now() - i * 7 * 86400000,
			start = end - 7 * 86400000,
			r = await one<{ statuses: number; logins: number; registrations: number }>(
				c.env,
				`SELECT (SELECT COUNT(*) FROM statuses WHERE local=1 AND created_at>=? AND created_at<?) statuses,(SELECT COUNT(*) FROM accounts WHERE domain='' AND last_seen_at>=? AND last_seen_at<?) logins,(SELECT COUNT(*) FROM accounts WHERE domain='' AND created_at>=? AND created_at<?) registrations`,
				...Array.from({ length: 3 }, () => [new Date(start).toISOString(), new Date(end).toISOString()]).flat()
			)
		rows.push({
			week: String(Math.floor(start / 1000)),
			statuses: String(r!.statuses),
			logins: String(r!.logins),
			registrations: String(r!.registrations),
		})
	}
	return c.json(rows)
})
