import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ipPolicy } from './moderation-policy'
import { web } from './web'
import { auth } from './auth/routes'
import { security } from './auth/security'
import { authenticate, lookupToken, optionalAccount, webSession } from './auth/access'
import { permits } from './auth/scopes'
import { ApiError, escapeHtml } from './http'
import { consume, sweep } from './jobs'
import { media } from './media/routes'
import { maxMediaBytes, MEDIA_TYPES } from './media/process'
import { accountJSON, statusJSON, visible } from './serializers'
import { statuses, timeline } from './statuses'
import { social } from './social'
import { organize } from './organize'
import { timelines } from './timelines'
import { streaming } from './streaming/routes'
import { push } from './push'
import { conversations } from './conversations'
import { search } from './search'
import { profile } from './profile'
import { admin } from './admin'
import { community } from './community'
import { metrics } from './metrics'
import { lifecycle } from './lifecycle'
import { instance } from './instance'
import { collections } from './collections'
import { protocol, extensionInbox } from './federation/consent'
import { vapid } from './push'
import { statusActions } from './status-actions'
import { notifications } from './notifications'
import { federationMiddleware } from './federation'
import type { AccountRow, AppEnv, AppRow, Env, JobMessage, StatusRow } from './types'
import { hidden, page } from './views'
export { StreamHub } from './streaming/hub'

export const app = new Hono<AppEnv>()
app.use('*', async (c, next) => {
	c.set('requestId', crypto.randomUUID())
	c.header('X-Request-Id', c.get('requestId'))
	c.header('X-Content-Type-Options', 'nosniff')
	// Preserve Origin on same-origin HTML POSTs so browser forms pass CSRF
	// validation. Cross-origin navigation still receives no referrer.
	c.header('Referrer-Policy', 'same-origin')
	c.header('Cache-Control', 'no-store')
	c.header(
		'Content-Security-Policy',
		"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: blob:; media-src 'self' https: blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
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
app.notFound((c) => c.json({ error: 'Record not found' }, 404))
app.use('*', async (c, next) => {
	if (c.env.MAINTENANCE_MODE === 'true') {
		c.header('Retry-After', '300')
		return c.json({ status: 'maintenance', maintenance: true }, c.req.path === '/health/live' ? 200 : 503)
	}
	if ((await ipPolicy(c.env, c.req.header('CF-Connecting-IP'))) === 'no_access')
		throw new ApiError(403, 'Access denied')
	await next()
})
app.use('*', extensionInbox)
app.route('/', protocol)
app.route('/', collections)
app.use('*', async (c, next) =>
	/^(\/users\/|\/inbox$|\/nodeinfo\/|\/\.well-known\/(webfinger|nodeinfo)$)/.test(c.req.path)
		? federationMiddleware(c, next)
		: next()
)
app.route('/', instance)
app.route('/', admin)
app.route('/', metrics)
app.route('/', lifecycle)
app.route('/', community)
app.route('/', profile)
app.route('/', search)
app.route('/', conversations)
app.route('/', streaming)
app.route('/', push)
app.route('/', timelines)
app.route('/', organize)
app.route('/', statusActions)
app.route('/', social)
app.route('/', notifications)
app.route('/', security)
app.route('/', auth)
app.route('/', media)
app.route('/', statuses)

app.get('/api/v1/apps/verify_credentials', async (c) => {
	const token = await authenticate(c, undefined, false)
	const record = await c.env.DB.prepare('SELECT * FROM oauth_apps WHERE id=?').bind(token.app_id).first<AppRow>()
	return c.json({
		id: record!.id,
		vapid_key: (await vapid(c.env)).public,
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
app.get('/api/v1/accounts/:id', async (c) => {
	const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id=?')
		.bind(c.req.param('id'))
		.first<AccountRow>()
	if (!account) throw new ApiError(404, 'Record not found')
	return c.json(await accountJSON(c.env, account))
})
app.get('/avatar.svg', (c) =>
	c.body(
		'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="#172d25"/><text x="200" y="250" text-anchor="middle" font-family="sans-serif" font-size="180" fill="#b4efc4">H</text></svg>',
		200,
		{ 'Content-Type': 'image/svg+xml' }
	)
)
app.route('/', web)
app.patch('/api/*', (c) => app.fetch(new Request(c.req.raw, { method: 'PUT' }), c.env, c.executionCtx))
for (const path of ['/api/v1/profile', '/api/v1/notifications/policy', '/api/v2/notifications/policy'])
	app.put(path, (c) => app.fetch(new Request(c.req.raw, { method: 'PATCH' }), c.env, c.executionCtx))
app.get('/assets/*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound()))

export default {
	fetch: app.fetch,
	queue: consume,
	scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
		ctx.waitUntil(sweep(env))
	},
} satisfies ExportedHandler<Env, JobMessage>
