import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { nextId } from '../db'
import { ApiError, escapeHtml, readInput, sameOrigin, stringField, throttle, CONTENT_SECURITY_POLICY } from '../http'
import type { AccountRow, AppEnv, AppRow } from '../types'
import { page, hidden } from '../views'
import { authenticate, webSession } from './access'
import { digest, equal, passwordHash, randomToken, verifyPassword } from './crypto'
import { parseScopes, SCOPES, subset } from './scopes'
import { verifySecondFactor, createSession, revokeSession } from './security'
import { vapid } from '../push'

export const auth = new Hono<AppEnv>()
const OOB = 'urn:ietf:wg:oauth:2.0:oob'
const cookieOptions = (origin: string) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'Lax' as const,
	secure: origin.startsWith('https:'),
})

function localReturn(value: string): string {
	return value.startsWith('/oauth/authorize?') && !value.includes('\\') && value.length <= 8192 ? value : '/'
}
function validRedirect(value: string): boolean {
	if (value === OOB) return true
	try {
		const url = new URL(value)
		return (
			value.length <= 2048 &&
			!url.hash &&
			!url.username &&
			!url.password &&
			!['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol) &&
			!/[\r\n\s]/.test(value)
		)
	} catch {
		return false
	}
}

auth.get('/setup', async (c) => {
	if (await c.env.DB.prepare('SELECT id FROM accounts LIMIT 1').first()) return c.redirect('/login')
	if (!c.env.SETUP_TOKEN) throw new ApiError(503, 'Set the SETUP_TOKEN Worker secret before creating the owner account')
	const csrf = randomToken()
	setCookie(c, 'hyena_form', csrf, { ...cookieOptions(c.env.PUBLIC_ORIGIN), maxAge: 600 })
	return c.html(
		page(
			'Set up your home',
			`<h1>Set up your home</h1><p>Create your owner account. Registration is closed after this step.</p><form method="post">${hidden('csrf', csrf)}<label for="setup_token">Setup token</label><input id="setup_token" name="setup_token" type="password" required autocomplete="off"><label for="username">Username</label><input id="username" name="username" pattern="[a-zA-Z0-9_]{1,30}" maxlength="30" required autocomplete="username"><label for="password">Password</label><input id="password" name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"><button>Create account</button></form>`
		)
	)
})

auth.post('/setup', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	const input = await readInput(c.req.raw)
	if (!equal(getCookie(c, 'hyena_form') ?? '', stringField(input, 'csrf')) || !stringField(input, 'csrf'))
		throw new ApiError(403, 'Invalid form token')
	await throttle(c, 'setup')
	if (!c.env.SETUP_TOKEN || !equal(await digest(stringField(input, 'setup_token')), await digest(c.env.SETUP_TOKEN)))
		throw new ApiError(403, 'Invalid setup token')
	if (await c.env.DB.prepare('SELECT id FROM accounts LIMIT 1').first())
		throw new ApiError(409, 'The owner account already exists')
	const username = stringField(input, 'username').toLowerCase()
	const password = stringField(input, 'password')
	if (!/^[a-z0-9_]{1,30}$/.test(username) || password.length < 12 || password.length > 256)
		throw new ApiError(422, 'Use a valid username and a password between 12 and 256 characters')
	const id = await nextId(c.env.DB)
	// A singleton constraint closes the race between two simultaneous setups.
	const result = await c.env.DB.prepare(
		`INSERT INTO accounts(id, username, password_hash, created_at, owner_slot, role)
    SELECT ?, ?, ?, ?, 1, 'admin' WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE domain='')`
	)
		.bind(id, username, passwordHash(password), new Date().toISOString())
		.run()
	if (!result.meta.changes) throw new ApiError(409, 'The owner account already exists')
	deleteCookie(c, 'hyena_form', cookieOptions(c.env.PUBLIC_ORIGIN))
	return c.redirect('/login', 303)
})

auth.get('/login', async (c) => {
	const csrf = randomToken()
	setCookie(c, 'hyena_form', csrf, { ...cookieOptions(c.env.PUBLIC_ORIGIN), maxAge: 600 })
	return c.html(
		page(
			'Sign in',
			`<h1>Welcome home</h1><form method="post">${hidden('csrf', csrf)}${hidden('return_to', localReturn(c.req.query('return_to') ?? '/'))}<label for="username">Username</label><input id="username" name="username" required autocomplete="username"><label for="password">Password</label><input id="password" name="password" type="password" maxlength="256" required autocomplete="current-password"><label for="otp">Authenticator or recovery code (if enabled)</label><input id="otp" name="otp" autocomplete="one-time-code"><button>Sign in</button></form><p><a href="/auth/password/new">Reset password</a></p><button id="passkey-login">Sign in with a passkey</button><script src="/assets/login.js" defer></script>`
		)
	)
})

auth.post('/login', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	const input = await readInput(c.req.raw)
	const csrf = stringField(input, 'csrf')
	if (!csrf || !equal(csrf, getCookie(c, 'hyena_form') ?? '')) throw new ApiError(403, 'Invalid form token')
	const username = stringField(input, 'username').toLowerCase()
	const password = stringField(input, 'password')
	if (username.length > 30 || password.length > 256) throw new ApiError(401, 'Invalid username or password')
	await throttle(c, `login:${username}`)
	const account = await c.env.DB.prepare(
		`SELECT * FROM accounts WHERE username = ? AND domain='' AND disabled=0 AND suspended=0 AND approved=1 AND (email IS NULL OR email_confirmed=1)`
	)
		.bind(username)
		.first<AccountRow>()
	if (!account || !verifyPassword(password, account.password_hash))
		throw new ApiError(401, 'Invalid username or password')
	if (!(await verifySecondFactor(c.env, account.id, stringField(input, 'otp'))))
		throw new ApiError(401, 'A valid authenticator or recovery code is required')
	await createSession(c, account)
	deleteCookie(c, 'hyena_form', cookieOptions(c.env.PUBLIC_ORIGIN))
	return c.redirect(localReturn(stringField(input, 'return_to')), 303)
})

auth.post('/logout', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	const session = await webSession(c)
	const input = await readInput(c.req.raw)
	if (!session || !equal(session.csrf, stringField(input, 'csrf'))) throw new ApiError(403, 'Invalid form token')
	await revokeSession(c.env, await digest(getCookie(c, 'hyena_session')!), session.account_id)
	deleteCookie(c, 'hyena_session', cookieOptions(c.env.PUBLIC_ORIGIN))
	return c.redirect('/', 303)
})

auth.post('/api/v1/apps', async (c) => {
	await throttle(c, 'app-registration')
	const input = await readInput(c.req.raw)
	const name = stringField(input, 'client_name')
	if (!name.trim() || name.length > 128) throw new ApiError(422, 'client_name is required (maximum 128 characters)')
	const redirectInput = input.redirect_uris
	const redirects = typeof redirectInput === 'string' ? redirectInput.split(/\r?\n/).filter(Boolean) : redirectInput
	if (
		!Array.isArray(redirects) ||
		!redirects.length ||
		redirects.length > 16 ||
		redirects.some((uri) => typeof uri !== 'string' || !validRedirect(uri))
	)
		throw new ApiError(422, 'Invalid redirect_uris')
	const scopes = parseScopes(stringField(input, 'scopes', 'read')).join(' ')
	const website = stringField(input, 'website')
	if (website && (!/^https?:\/\//.test(website) || !validRedirect(website))) throw new ApiError(422, 'Invalid website')
	const id = await nextId(c.env.DB),
		clientId = randomToken(),
		secret = randomToken()
	await c.env.DB.prepare(
		`INSERT INTO oauth_apps(id, name, website, client_id, secret_hash, redirect_uris, scopes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			name,
			website || null,
			clientId,
			await digest(secret),
			JSON.stringify([...new Set(redirects)]),
			scopes,
			new Date().toISOString()
		)
		.run()
	return c.json({
		id,
		name,
		website: website || null,
		client_id: clientId,
		client_secret: secret,
		client_secret_expires_at: 0,
		vapid_key: (await vapid(c.env)).public,
		scopes: scopes.split(' '),
		redirect_uris: redirects,
		redirect_uri: redirects.join('\n'),
	})
})

async function authorization(c: Parameters<typeof webSession>[0], input: Record<string, unknown>) {
	if (stringField(input, 'response_type') !== 'code')
		throw new ApiError(400, 'Only the code response type is supported', 'unsupported_response_type')
	if (!['query', 'fragment', 'form_post'].includes(stringField(input, 'response_mode', 'query')))
		throw new ApiError(400, 'Unsupported response mode', 'invalid_request')
	const app = await c.env.DB.prepare('SELECT * FROM oauth_apps WHERE client_id = ?')
		.bind(stringField(input, 'client_id'))
		.first<AppRow>()
	if (!app) throw new ApiError(400, 'Unknown application', 'invalid_client')
	const redirect = stringField(input, 'redirect_uri')
	if (!(JSON.parse(app.redirect_uris) as string[]).includes(redirect))
		throw new ApiError(400, 'Unregistered redirect URI', 'invalid_request')
	// Callback origins become CSP sources. Reject wildcard hosts and directive
	// delimiters, including on applications registered before this validation.
	const callback = new URL(redirect)
	if (
		['https:', 'http:'].includes(callback.protocol) &&
		!/^https?:\/\/(?:[a-z0-9._-]+|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(callback.origin)
	)
		throw new ApiError(400, 'Invalid callback origin', 'invalid_request')
	const scopes = parseScopes(stringField(input, 'scope', 'read'))
	if (!subset(scopes, app.scopes))
		throw new ApiError(400, 'Requested scopes exceed the application scopes', 'invalid_scope')
	const challenge = stringField(input, 'code_challenge')
	const method = stringField(input, 'code_challenge_method')
	if ((challenge && (method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))) || (!challenge && method))
		throw new ApiError(400, 'PKCE requires an S256 challenge', 'invalid_request')
	return {
		app,
		redirect,
		scopes: scopes.join(' '),
		challenge,
		state: stringField(input, 'state'),
		mode: stringField(input, 'response_mode', 'query'),
	}
}

function authorizationResponse(
	c: Parameters<typeof webSession>[0],
	request: { redirect: string; state: string; mode: string },
	values: Record<string, string>
) {
	const params = new URLSearchParams(values)
	if (request.state) params.set('state', request.state)
	if (request.mode === 'form_post') {
		const action = new URL(request.redirect)
		if (!['https:', 'http:'].includes(action.protocol)) throw new ApiError(400, 'form_post requires an HTTP callback')
		const nonce = randomToken()
		c.header(
			'Content-Security-Policy',
			`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action ${action.origin}; frame-ancestors 'none'; base-uri 'none'`
		)
		return c.html(
			page(
				'Return to your app',
				`<form id="callback" action="${escapeHtml(request.redirect)}" method="post">${[...params].map(([k, v]) => hidden(k, v)).join('')}<button>Continue to your app</button></form><script nonce="${nonce}">document.getElementById('callback').submit()</script>`
			)
		)
	}
	const target = new URL(request.redirect)
	if (request.mode === 'fragment') target.hash = params.toString()
	else for (const [k, v] of params) target.searchParams.set(k, v)
	return c.redirect(target.href, 303)
}

auth.get('/oauth/authorize', async (c) => {
	if (c.req.url.length > 8192) throw new ApiError(400, 'Authorization request too long')
	const input = Object.fromEntries(new URL(c.req.url).searchParams)
	const request = await authorization(c, input)
	const session = await webSession(c)
	if (!session || input.force_login === 'true') {
		const returnUrl = new URL(c.req.url)
		returnUrl.searchParams.delete('force_login')
		return c.redirect(`/login?return_to=${encodeURIComponent(returnUrl.pathname + returnUrl.search)}`)
	}
	const fields = Object.entries(input)
		.map(([key, value]) => hidden(key, value))
		.join('')
	if (request.redirect !== OOB && request.mode !== 'form_post') {
		const callback = new URL(request.redirect)
		const source = ['http:', 'https:'].includes(callback.protocol) ? callback.origin : callback.protocol
		// Browsers apply the submitting document's form-action policy to the
		// redirect too. Allow only this validated callback's origin or app scheme.
		c.header(
			'Content-Security-Policy',
			CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' ${source}`)
		)
	}
	return c.html(
		page(
			'Connect an app',
			`<h1>Connect ${escapeHtml(request.app.name)}?</h1><p>This app is requesting: <code>${escapeHtml(request.scopes)}</code></p><form method="post">${fields}${hidden('csrf', session.csrf)}<button name="decision" value="allow">Authorize app</button><button name="decision" value="deny">Cancel</button></form>`
		)
	)
})

auth.post('/oauth/authorize', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	const input = await readInput(c.req.raw)
	const session = await webSession(c)
	if (!session || !equal(session.csrf, stringField(input, 'csrf'))) throw new ApiError(403, 'Invalid form token')
	const request = await authorization(c, input)
	if (stringField(input, 'decision') !== 'allow') {
		if (request.redirect === OOB) return c.html(page('Authorization cancelled', '<h1>Authorization cancelled</h1>'))
		return authorizationResponse(c, request, { error: 'access_denied' })
	}
	const code = randomToken()
	await c.env.DB.prepare(
		'INSERT INTO oauth_codes(code_hash, app_id, account_id, redirect_uri, scopes, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	)
		.bind(
			await digest(code),
			request.app.id,
			session.account_id,
			request.redirect,
			request.scopes,
			request.challenge || null,
			Date.now() + 600_000
		)
		.run()
	if (request.redirect === OOB)
		return c.html(
			page(
				'Authorization code',
				`<h1>Your authorization code</h1><p>Copy this code into your app.</p><pre>${escapeHtml(code)}</pre>`
			)
		)
	return authorizationResponse(c, request, { code })
})

async function clientAuthentication(
	c: Parameters<typeof webSession>[0],
	input: Record<string, unknown>
): Promise<AppRow> {
	let clientId = stringField(input, 'client_id'),
		secret = stringField(input, 'client_secret')
	const basic = c.req.header('Authorization')
	if (basic) {
		if (!basic.startsWith('Basic ') || clientId || secret)
			throw new ApiError(401, 'Invalid client authentication', 'invalid_client')
		try {
			const decoded = atob(basic.slice(6))
			const colon = decoded.indexOf(':')
			if (colon < 0) throw new Error('Invalid basic authentication')
			clientId = decodeURIComponent(decoded.slice(0, colon))
			secret = decodeURIComponent(decoded.slice(colon + 1))
		} catch {
			throw new ApiError(401, 'Invalid client authentication', 'invalid_client')
		}
	}
	const app = await c.env.DB.prepare('SELECT * FROM oauth_apps WHERE client_id = ?').bind(clientId).first<AppRow>()
	if (!app || !equal(await digest(secret), app.secret_hash))
		throw new ApiError(401, 'Invalid application credentials', 'invalid_client')
	return app
}

auth.post('/oauth/token', async (c) => {
	const input = await readInput(c.req.raw)
	const app = await clientAuthentication(c, input)
	await throttle(c, `token:${app.id}`)
	const grant = stringField(input, 'grant_type')
	const raw = randomToken(),
		tokenHash = await digest(raw),
		now = Date.now()
	let scopes: string
	if (grant === 'client_credentials') {
		const requested = parseScopes(stringField(input, 'scope', 'read'))
		if (!subset(requested, app.scopes)) throw new ApiError(400, 'Invalid scopes', 'invalid_scope')
		scopes = requested.join(' ')
		await c.env.DB.prepare('INSERT INTO oauth_tokens(token_hash, app_id, scopes, created_at) VALUES (?, ?, ?, ?)')
			.bind(tokenHash, app.id, scopes, now)
			.run()
	} else if (grant === 'authorization_code') {
		const codeHash = await digest(stringField(input, 'code'))
		const code = await c.env.DB.prepare(
			'SELECT * FROM oauth_codes WHERE code_hash = ? AND app_id = ? AND expires_at > ? AND used_at IS NULL'
		)
			.bind(codeHash, app.id, now)
			.first<{ account_id: string; redirect_uri: string; challenge: string | null; scopes: string }>()
		if (!code || code.redirect_uri !== stringField(input, 'redirect_uri'))
			throw new ApiError(400, 'Invalid, expired or used authorization code', 'invalid_grant')
		const verifier = stringField(input, 'code_verifier')
		if (
			code.challenge &&
			(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(await digest(verifier), code.challenge))
		)
			throw new ApiError(400, 'Invalid PKCE verifier', 'invalid_grant')
		// Token insertion and code consumption share a transaction. A concurrent
		// exchange either inserts nothing or loses the unique code_hash constraint.
		const results = await c.env.DB.batch([
			c.env.DB.prepare(
				`INSERT INTO oauth_tokens(token_hash, app_id, account_id, scopes, code_hash, created_at)
        SELECT ?, app_id, account_id, scopes, code_hash, ? FROM oauth_codes
        WHERE code_hash = ? AND app_id = ? AND used_at IS NULL AND expires_at > ?`
			).bind(tokenHash, now, codeHash, app.id, now),
			c.env.DB.prepare(
				`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?
        AND EXISTS(SELECT 1 FROM oauth_tokens WHERE token_hash = ?)`
			).bind(now, codeHash, tokenHash),
		])
		if (!results[0]?.meta.changes) throw new ApiError(400, 'Authorization code already used', 'invalid_grant')
		scopes = code.scopes
	} else throw new ApiError(400, 'Unsupported grant type', 'unsupported_grant_type')
	return c.json({ access_token: raw, token_type: 'Bearer', scope: scopes, created_at: Math.floor(now / 1000) })
})

auth.post('/oauth/revoke', async (c) => {
	const input = await readInput(c.req.raw),
		app = await clientAuthentication(c, input)
	const hash = await digest(stringField(input, 'token'))
	const token = await c.env.DB.prepare('SELECT account_id FROM oauth_tokens WHERE token_hash = ? AND app_id = ?')
		.bind(hash, app.id)
		.first<{ account_id: string | null }>()
	if (!token) throw new ApiError(403, 'Token does not belong to this application', 'unauthorized_client')
	await c.env.DB.prepare(
		'UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ? AND app_id = ?'
	)
		.bind(Date.now(), hash, app.id)
		.run()
	await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE token_hash=?').bind(hash).run()
	if (token.account_id) await c.env.STREAMS.get(c.env.STREAMS.idFromName(token.account_id)).revoke(hash)
	return c.json({})
})

auth.on(['GET', 'POST'], '/oauth/userinfo', async (c) => {
	await authenticate(c, 'profile')
	const account = c.get('account'),
		origin = c.env.PUBLIC_ORIGIN
	return c.json({
		iss: origin + '/',
		sub: `${origin}/users/${account.username}`,
		name: account.display_name || account.username,
		preferred_username: account.username,
		profile: `${origin}/@${account.username}`,
		picture: `${origin}/avatar.svg`,
	})
})
auth.get('/.well-known/oauth-authorization-server', (c) => {
	const origin = c.env.PUBLIC_ORIGIN
	return c.json({
		issuer: origin + '/',
		authorization_endpoint: origin + '/oauth/authorize',
		token_endpoint: origin + '/oauth/token',
		revocation_endpoint: origin + '/oauth/revoke',
		app_registration_endpoint: origin + '/api/v1/apps',
		userinfo_endpoint: origin + '/oauth/userinfo',
		scopes_supported: SCOPES,
		response_types_supported: ['code'],
		response_modes_supported: ['query', 'fragment', 'form_post'],
		grant_types_supported: ['authorization_code', 'client_credentials'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
	})
})
