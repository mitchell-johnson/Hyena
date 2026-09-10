import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './auth/routes'
import { authenticate, lookupToken, optionalAccount, webSession } from './auth/access'
import { permits } from './auth/scopes'
import { ApiError, escapeHtml } from './http'
import { consume, sweep } from './jobs'
import { media } from './media/routes'
import { maxMediaBytes, MEDIA_TYPES } from './media/process'
import { accountJSON, statusJSON, visible } from './serializers'
import { statuses, timeline } from './statuses'
import type { AccountRow, AppEnv, AppRow, Env, JobMessage, StatusRow } from './types'
import { hidden, page } from './views'
export { StreamHub } from './streaming/hub'

const app = new Hono<AppEnv>()
app.use('*', async (c, next) => {
	c.set('requestId', crypto.randomUUID())
	c.header('X-Request-Id', c.get('requestId'))
	c.header('X-Content-Type-Options', 'nosniff')
	c.header('Referrer-Policy', 'no-referrer')
	c.header('Cache-Control', 'no-store')
	c.header(
		'Content-Security-Policy',
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
	)
	await next()
})
const apiCors = cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
	exposeHeaders: ['Link', 'Retry-After', 'X-Request-Id'],
})
app.use('/api/*', apiCors)
app.use('/oauth/token', apiCors)
app.use('/oauth/revoke', apiCors)
app.use('/.well-known/oauth-authorization-server', apiCors)
app.onError((error, c) => {
	if (error instanceof ApiError)
		return c.json(
			error.code ? { error: error.code, error_description: error.message } : { error: error.message },
			error.status
		)
	// Never log request URLs, tokens, passwords, bodies, or raw SQL errors.
	console.error(JSON.stringify({ event: 'request_failed', requestId: c.get('requestId'), type: error.name }))
	return c.json({ error: 'Internal error', request_id: c.get('requestId') }, 500)
})
app.notFound((c) => c.json({ error: 'This endpoint is not implemented in the current Hyena milestone' }, 404))
app.route('/', auth)
app.route('/', media)
app.route('/', statuses)

function configuration(env: Env) {
	return {
		urls: { streaming: env.PUBLIC_ORIGIN.replace(/^http/, 'ws') },
		statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 },
		media_attachments: {
			supported_mime_types: MEDIA_TYPES,
			image_size_limit: maxMediaBytes(env),
			image_matrix_limit: 40_000_000,
			video_size_limit: maxMediaBytes(env),
			video_frame_rate_limit: 60,
			video_matrix_limit: 1920 * 1080,
		},
		translation: { enabled: false },
		limited_federation: false,
	}
}
app.get('/health', (c) => c.json({ status: 'ok', software: 'hyena', version: '0.1.0-alpha.1' }))
app.get('/api/v2/instance', async (c) => {
	const account = await c.env.DB.prepare('SELECT * FROM accounts LIMIT 1').first<AccountRow>()
	return c.json({
		domain: new URL(c.env.PUBLIC_ORIGIN).host,
		title: c.env.INSTANCE_TITLE,
		version: '0.1.0-alpha.1+hyena',
		source_url: 'https://github.com/mitchell-johnson/Hyena',
		description: c.env.INSTANCE_DESCRIPTION,
		usage: { users: { active_month: account ? 1 : 0 } },
		thumbnail: { url: c.env.PUBLIC_ORIGIN + '/avatar.svg' },
		languages: ['en'],
		configuration: configuration(c.env),
		registrations: { enabled: false, approval_required: true, message: null, min_age: null },
		contact: { email: '', account: account ? await accountJSON(c.env, account) : null },
		rules: [],
		icon: [],
		api_versions: { mastodon: 0 },
		hyena: {
			milestone: 'local-posting',
			federation: false,
			max_media_duration_seconds: 60,
			media_duration_exclusive: true,
		},
	})
})
app.get('/api/v1/instance', async (c) => {
	const account = await c.env.DB.prepare('SELECT * FROM accounts LIMIT 1').first<AccountRow>()
	const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM statuses WHERE deleted_at IS NULL').first<{
		n: number
	}>()
	return c.json({
		uri: new URL(c.env.PUBLIC_ORIGIN).host,
		title: c.env.INSTANCE_TITLE,
		short_description: c.env.INSTANCE_DESCRIPTION,
		description: c.env.INSTANCE_DESCRIPTION,
		email: '',
		version: '0.1.0-alpha.1+hyena',
		urls: { streaming_api: c.env.PUBLIC_ORIGIN.replace(/^http/, 'ws') },
		stats: { user_count: account ? 1 : 0, status_count: count?.n ?? 0, domain_count: 0 },
		thumbnail: c.env.PUBLIC_ORIGIN + '/avatar.svg',
		languages: ['en'],
		registrations: false,
		approval_required: true,
		invites_enabled: false,
		configuration: configuration(c.env),
		contact_account: account ? await accountJSON(c.env, account) : null,
		rules: [],
	})
})
app.get('/api/v1/apps/verify_credentials', async (c) => {
	const token = await authenticate(c, undefined, false)
	const record = await c.env.DB.prepare('SELECT * FROM oauth_apps WHERE id=?').bind(token.app_id).first<AppRow>()
	return c.json({
		id: record!.id,
		name: record!.name,
		website: record!.website,
		scopes: record!.scopes.split(' '),
		redirect_uris: JSON.parse(record!.redirect_uris),
		redirect_uri: JSON.parse(record!.redirect_uris).join('\n'),
	})
})
app.get('/api/v1/accounts/verify_credentials', async (c) => {
	await authenticate(c, 'read:accounts')
	return c.json(await accountJSON(c.env, c.get('account'), true))
})
app.get('/api/v1/preferences', async (c) => {
	await authenticate(c, 'read:accounts')
	return c.json({
		'posting:default:visibility': 'public',
		'posting:default:sensitive': false,
		'posting:default:language': null,
		'reading:expand:media': 'default',
		'reading:expand:spoilers': false,
	})
})
app.get('/api/v1/accounts/lookup', async (c) => {
	const acct = c.req.query('acct') ?? '',
		parts = acct.split('@')
	if (parts.length > 2 || (parts[1] && parts[1] !== new URL(c.env.PUBLIC_ORIGIN).host))
		throw new ApiError(404, 'Record not found')
	const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE username=?')
		.bind(parts[0] ?? '')
		.first<AccountRow>()
	if (!account) throw new ApiError(404, 'Record not found')
	return c.json(await accountJSON(c.env, account))
})
app.get('/api/v1/accounts/:id/statuses', (c) => timeline(c, 'account', c.req.param('id')))
app.get('/api/v1/accounts/:id', async (c) => {
	const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id=?')
		.bind(c.req.param('id'))
		.first<AccountRow>()
	if (!account) throw new ApiError(404, 'Record not found')
	return c.json(await accountJSON(c.env, account))
})
app.get('/api/v1/streaming', async (c) => {
	if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket')
		throw new ApiError(501, 'SSE streaming is not implemented yet; use WebSocket streaming')
	const token = await lookupToken(
		c.env,
		c.req.header('Authorization')?.replace(/^Bearer /i, '') ?? c.req.query('access_token')
	)
	if (!token?.account_id) throw new ApiError(401, 'The access token is invalid')
	if (!permits(token.scopes, 'read:statuses')) throw new ApiError(403, 'Missing read:statuses scope')
	const headers = new Headers({ Upgrade: 'websocket', 'X-Hyena-Token': token.token_hash })
	return c.env.STREAMS.get(c.env.STREAMS.idFromName(token.account_id)).fetch(new Request(c.req.url, { headers }))
})
app.get('/avatar.svg', (c) =>
	c.body(
		'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="#172d25"/><text x="200" y="250" text-anchor="middle" font-family="sans-serif" font-size="180" fill="#b4efc4">H</text></svg>',
		200,
		{ 'Content-Type': 'image/svg+xml' }
	)
)
app.get('/', async (c) => {
	const account = await c.env.DB.prepare('SELECT * FROM accounts LIMIT 1').first<AccountRow>()
	const session = await webSession(c)
	return c.html(
		page(
			c.env.INSTANCE_TITLE,
			`<h1>${escapeHtml(c.env.INSTANCE_TITLE)}</h1><p>${escapeHtml(c.env.INSTANCE_DESCRIPTION)}</p><p>This is an early Hyena development instance. Local posting and app authorization are available. Federation is still being built.</p>${account ? `<p><a href="/@${escapeHtml(account.username)}">@${escapeHtml(account.username)}</a></p>` : '<p><a href="/setup">Create the owner account</a></p>'}${session ? `<form action="/logout" method="post">${hidden('csrf', session.csrf)}<button>Sign out</button></form>` : '<p><a href="/login">Sign in</a></p>'}`
		)
	)
})
app.get('/@:username/:id', async (c) => {
	const viewer = await optionalAccount(c),
		row = await c.env.DB.prepare('SELECT * FROM statuses WHERE id=?').bind(c.req.param('id')).first<StatusRow>()
	if (!row || !visible(row, viewer)) throw new ApiError(404, 'Record not found')
	const status = await statusJSON(c.env, row, viewer)
	if (status.account.username !== c.req.param('username')) throw new ApiError(404, 'Record not found')
	return c.html(
		page(
			`@${status.account.username}`,
			`<h1>@${escapeHtml(status.account.username)}</h1>${row.spoiler_text ? `<p>${escapeHtml(row.spoiler_text)}</p>` : ''}${row.content}<p>${escapeHtml(row.created_at)}</p>`
		)
	)
})
app.get('/@:username', async (c) => {
	const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE username=?')
		.bind(c.req.param('username'))
		.first<AccountRow>()
	if (!account) throw new ApiError(404, 'Record not found')
	const posts = await c.env.DB.prepare(
		"SELECT * FROM statuses WHERE account_id=? AND visibility='public' AND deleted_at IS NULL ORDER BY sequence DESC LIMIT 20"
	)
		.bind(account.id)
		.all<StatusRow>()
	return c.html(
		page(
			`@${account.username}`,
			`<h1>@${escapeHtml(account.username)}</h1>${posts.results.map((s) => `<article>${s.content}<p><a href="/@${escapeHtml(account.username)}/${s.id}">${escapeHtml(s.created_at)}</a></p></article>`).join('')}`
		)
	)
})

export default {
	fetch: app.fetch,
	queue: consume,
	scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
		ctx.waitUntil(sweep(env))
	},
} satisfies ExportedHandler<Env, JobMessage>
