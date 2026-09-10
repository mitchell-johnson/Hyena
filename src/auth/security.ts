import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	type RegistrationResponseJSON,
	type AuthenticationResponseJSON,
	type AuthenticatorTransport,
} from '@simplewebauthn/server'
import { all, one, run, parsed, object, now, accountById } from '../data'
import { ApiError, boundedBytes, readInput, sameOrigin, stringField, throttle, escapeHtml } from '../http'
import { webSession } from './access'
import { digest, equal, passwordHash, verifyPassword, randomToken } from './crypto'
import { canonicalEmail } from '../moderation-policy'
import { seal, unseal } from '../federation/keys'
import { page, hidden } from '../views'
import type { AccountRow, AppEnv, Env } from '../types'

export const security = new Hono<AppEnv>()
export const sessionCookie = (origin: string) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'Lax' as const,
	secure: origin.startsWith('https:'),
})
export async function createSession(c: Context<AppEnv>, a: AccountRow) {
	const token = randomToken()
	await c.env.DB.batch([
		c.env.DB.prepare('INSERT INTO sessions(token_hash,account_id,csrf,expires_at) VALUES(?,?,?,?)').bind(
			await digest(token),
			a.id,
			randomToken(),
			Date.now() + 8 * 3600000
		),
		c.env.DB.prepare('UPDATE accounts SET last_seen_at=? WHERE id=?').bind(now(), a.id),
	])
	setCookie(c, 'hyena_session', token, { ...sessionCookie(c.env.PUBLIC_ORIGIN), maxAge: 8 * 3600 })
	return token
}
export async function requireWeb(c: Context<AppEnv>, input?: Record<string, unknown>) {
	const session = await webSession(c)
	if (!session) throw new ApiError(401, 'Sign in to continue')
	if (!['GET', 'HEAD'].includes(c.req.method)) {
		sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
		const csrf = c.req.header('X-CSRF-Token') ?? (input ? stringField(input, 'csrf') : '')
		if (!csrf || !equal(session.csrf, csrf)) throw new ApiError(403, 'Invalid form token')
	}
	const a = await accountById(c.env, session.account_id)
	if (a.disabled || a.suspended || !a.approved || (a.email && !a.email_confirmed))
		throw new ApiError(403, 'Account is unavailable')
	return { account: a, session }
}
async function passwordConfirmation(c: Context<AppEnv>, input: Record<string, unknown>) {
	const { account } = await requireWeb(c, input)
	await throttle(c, 'security:' + account.id)
	if (!verifyPassword(stringField(input, 'password'), account.password_hash))
		throw new ApiError(403, 'Current password is incorrect')
	return account
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32(bytes: Uint8Array) {
	let bits = 0,
		value = 0,
		out = ''
	for (const b of bytes) {
		value = (value << 8) | b
		bits += 8
		while (bits >= 5) {
			out += alphabet[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits) out += alphabet[(value << (5 - bits)) & 31]
	return out
}
function unbase32(value: string) {
	let bits = 0,
		n = 0
	const out = []
	for (const c of value.toUpperCase().replace(/=+$/, '')) {
		const i = alphabet.indexOf(c)
		if (i < 0) throw new ApiError(422, 'Invalid authenticator secret')
		n = (n << 5) | i
		bits += 5
		if (bits >= 8) {
			out.push((n >>> (bits - 8)) & 255)
			bits -= 8
		}
	}
	return new Uint8Array(out)
}
export async function totp(secret: string, counter: number) {
	const bytes = new Uint8Array(8)
	new DataView(bytes.buffer).setBigUint64(0, BigInt(counter))
	const key = await crypto.subtle.importKey('raw', unbase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']),
		mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes)),
		offset = mac.at(-1)! & 15,
		value = (new DataView(mac.buffer).getUint32(offset) & 0x7fffffff) % 1000000
	return String(value).padStart(6, '0')
}
export async function verifySecondFactor(env: Env, accountId: string, code: string) {
	const a = await one<{ totp_secret: string | null; totp_last_counter: number }>(
		env,
		'SELECT totp_secret,totp_last_counter FROM accounts WHERE id=?',
		accountId
	)
	if (!a?.totp_secret) return true
	const secret = await unseal<string>(env, a.totp_secret),
		current = Math.floor(Date.now() / 30000)
	if (/^\d{6}$/.test(code))
		for (const counter of [current, current - 1, current + 1])
			if (counter > a.totp_last_counter && equal(await totp(secret, counter), code))
				return !!(
					await run(
						env,
						'UPDATE accounts SET totp_last_counter=? WHERE id=? AND totp_last_counter<?',
						counter,
						accountId,
						counter
					)
				).meta.changes
	if (/^[A-Za-z0-9_-]{16,64}$/.test(code))
		return !!(
			await run(
				env,
				'UPDATE recovery_codes SET used_at=? WHERE account_id=? AND code_hash=? AND used_at IS NULL',
				now(),
				accountId,
				await digest(code)
			)
		).meta.changes
	return false
}
async function challenge(env: Env, accountId: string | null, kind: string, data: unknown) {
	const id = randomToken()
	await run(
		env,
		'INSERT INTO security_challenges VALUES(?,?,?,?,?)',
		await digest(id),
		accountId,
		kind,
		JSON.stringify(data),
		Date.now() + 300000
	)
	return id
}
async function consumeChallenge(env: Env, id: string, kind: string, accountId?: string) {
	const row = await env.DB.prepare(
		`DELETE FROM security_challenges WHERE id=? AND kind=? AND expires_at>? ${accountId ? 'AND account_id=?' : ''} RETURNING *`
	)
		.bind(await digest(id), kind, Date.now(), ...(accountId ? [accountId] : []))
		.first<{ account_id: string | null; data: string }>()
	if (!row) throw new ApiError(401, 'The security challenge expired or was already used')
	return { ...row, data: parsed<Record<string, unknown>>(row.data, {}) }
}
async function recoveryStatements(env: Env, id: string) {
	const codes = Array.from({ length: 10 }, () => randomToken().slice(0, 20))
	return {
		codes,
		statements: [
			env.DB.prepare('DELETE FROM recovery_codes WHERE account_id=?').bind(id),
			...(await Promise.all(
				codes.map(async (code) =>
					env.DB.prepare('INSERT INTO recovery_codes(account_id,code_hash) VALUES(?,?)').bind(id, await digest(code))
				)
			)),
		],
	}
}
security.get('/api/hyena/security', async (c) => {
	const { account: a } = await requireWeb(c)
	return c.json({
		email: a.email ?? null,
		two_factor: !!(await one<{ totp_secret: string }>(c.env, 'SELECT totp_secret FROM accounts WHERE id=?', a.id))
			?.totp_secret,
		passkeys: await all(c.env, 'SELECT id,name,transports,created_at FROM passkeys WHERE account_id=?', a.id),
		sessions: await all(c.env, 'SELECT token_hash AS id,expires_at FROM sessions WHERE account_id=?', a.id),
		applications: await all(
			c.env,
			'SELECT a.id,a.name,a.website,MAX(t.created_at) last_used FROM oauth_apps a JOIN oauth_tokens t ON t.app_id=a.id WHERE t.account_id=? AND t.revoked_at IS NULL GROUP BY a.id',
			a.id
		),
	})
})
security.post('/api/hyena/security/totp/start', async (c) => {
	const input = await readInput(c.req.raw),
		a = await passwordConfirmation(c, input)
	if ((await one<{ totp_secret: string }>(c.env, 'SELECT totp_secret FROM accounts WHERE id=?', a.id))?.totp_secret)
		throw new ApiError(409, 'Two-factor authentication is already enabled')
	const secret = base32(crypto.getRandomValues(new Uint8Array(20))),
		id = await challenge(c.env, a.id, 'totp', { secret: await seal(c.env, secret) })
	return c.json({
		challenge: id,
		secret,
		uri: `otpauth://totp/${encodeURIComponent(c.env.INSTANCE_TITLE + ':' + a.username)}?secret=${secret}&issuer=${encodeURIComponent(c.env.INSTANCE_TITLE)}&algorithm=SHA1&digits=6&period=30`,
	})
})
security.post('/api/hyena/security/totp/confirm', async (c) => {
	const input = await readInput(c.req.raw),
		{ account: a } = await requireWeb(c, input),
		ch = await consumeChallenge(c.env, stringField(input, 'challenge'), 'totp', a.id),
		secret = await unseal<string>(c.env, String(ch.data.secret)),
		code = stringField(input, 'code'),
		counter = Math.floor(Date.now() / 30000)
	if (!equal(await totp(secret, counter), code)) throw new ApiError(422, 'Authenticator code does not match')
	const recovery = await recoveryStatements(c.env, a.id)
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE accounts SET totp_secret=?,totp_last_counter=? WHERE id=? AND totp_secret IS NULL').bind(
			await seal(c.env, secret),
			counter,
			a.id
		),
		...recovery.statements,
	])
	return c.json({ recovery_codes: recovery.codes })
})
security.post('/api/hyena/security/totp/disable', async (c) => {
	const input = await readInput(c.req.raw),
		a = await passwordConfirmation(c, input)
	if (!(await verifySecondFactor(c.env, a.id, stringField(input, 'code'))))
		throw new ApiError(403, 'A current authenticator or recovery code is required')
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE accounts SET totp_secret=NULL,totp_last_counter=-1 WHERE id=?').bind(a.id),
		c.env.DB.prepare('DELETE FROM recovery_codes WHERE account_id=?').bind(a.id),
	])
	return c.json({})
})
security.post('/api/hyena/security/recovery_codes', async (c) => {
	const input = await readInput(c.req.raw),
		a = await passwordConfirmation(c, input)
	if (!(await verifySecondFactor(c.env, a.id, stringField(input, 'code'))))
		throw new ApiError(403, 'A current authenticator or recovery code is required')
	const recovery = await recoveryStatements(c.env, a.id)
	await c.env.DB.batch(recovery.statements)
	return c.json({ recovery_codes: recovery.codes })
})
security.post('/api/hyena/security/email', async (c) => {
	const input = await readInput(c.req.raw),
		a = await passwordConfirmation(c, input),
		email = stringField(input, 'email').trim().toLowerCase()
	if (!c.env.EMAIL) throw new ApiError(422, 'Email sending is not configured')
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, 'Invalid email')
	if (
		await one(
			c.env,
			"SELECT 1 FROM accounts WHERE email=? AND id<>? UNION ALL SELECT 1 FROM moderation_rules WHERE (kind='email_domain_blocks' AND value=?) OR (kind='canonical_email_blocks' AND value=?)",
			email,
			a.id,
			email.split('@')[1]!,
			await canonicalEmail(email)
		)
	)
		throw new ApiError(422, 'Email is unavailable')
	const token = randomToken()
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM email_tokens WHERE account_id=? AND purpose='change'").bind(a.id),
		c.env.DB.prepare(
			"INSERT INTO email_tokens(hash,account_id,purpose,expires_at,email) VALUES(?,?,'change',?,?)"
		).bind(await digest(token), a.id, Date.now() + 86400000, email),
		c.env.DB.prepare("INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'email.send',?,?,?)").bind(
			'email-change:' + crypto.randomUUID(),
			JSON.stringify({
				to: email,
				subject: 'Confirm your new Hyena email',
				text: `Confirm this email within 24 hours: ${c.env.PUBLIC_ORIGIN}/auth/email/change?token=${token}`,
			}),
			Date.now(),
			Date.now()
		),
	])
	return c.json({
		message: 'Check your new address for a confirmation link. Your existing email remains active until confirmation.',
	})
})
security.get('/auth/email/change', async (c) => {
	const hash = await digest(c.req.query('token') ?? '')
	const entry = await one<{ account_id: string; email: string }>(
		c.env,
		"SELECT account_id,email FROM email_tokens WHERE hash=? AND purpose='change' AND expires_at>?",
		hash,
		Date.now()
	)
	if (!entry || (await one(c.env, 'SELECT 1 FROM accounts WHERE email=? AND id<>?', entry.email, entry.account_id)))
		throw new ApiError(422, 'Invalid or expired email confirmation')
	await c.env.DB.batch([
		c.env.DB.prepare(
			"UPDATE accounts SET email=?,email_confirmed=1 WHERE id=? AND EXISTS(SELECT 1 FROM email_tokens WHERE hash=? AND purpose='change' AND expires_at>?)"
		).bind(entry.email, entry.account_id, hash, Date.now()),
		c.env.DB.prepare('DELETE FROM email_tokens WHERE account_id=?').bind(entry.account_id),
	])
	return c.html(
		page(
			'Email confirmed',
			'<h1>Email confirmed</h1><p>Your new email address is active.</p><a href="/settings">Back to settings</a>'
		)
	)
})
security.post('/api/hyena/security/password', async (c) => {
	const input = await readInput(c.req.raw),
		a = await passwordConfirmation(c, input),
		password = stringField(input, 'new_password')
	if (password.length < 12 || password.length > 256)
		throw new ApiError(422, 'Use a password between 12 and 256 characters')
	await changePassword(c.env, a.id, password)
	deleteCookie(c, 'hyena_session', sessionCookie(c.env.PUBLIC_ORIGIN))
	return c.json({ redirect: '/login' })
})
export async function changePassword(env: Env, id: string, password: string) {
	await env.DB.batch([
		env.DB.prepare('UPDATE accounts SET password_hash=? WHERE id=?').bind(passwordHash(password), id),
		env.DB.prepare('DELETE FROM sessions WHERE account_id=?').bind(id),
		env.DB.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').bind(
			Date.now(),
			id
		),
		env.DB.prepare("DELETE FROM email_tokens WHERE account_id=? AND purpose='password'").bind(id),
	])
	await env.STREAMS.get(env.STREAMS.idFromName(id)).revokeAll()
}
export async function revokeSession(env: Env, hash: string, accountId: string) {
	const row = await one<{ api_token_cipher: string | null }>(
		env,
		'SELECT api_token_cipher FROM sessions WHERE token_hash=? AND account_id=?',
		hash,
		accountId
	)
	if (row?.api_token_cipher) {
		const tokenHash = await digest(await unseal<string>(env, row.api_token_cipher))
		await env.DB.batch([
			env.DB.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE token_hash=?').bind(Date.now(), tokenHash),
			env.DB.prepare('DELETE FROM push_subscriptions WHERE token_hash=?').bind(tokenHash),
		])
		await env.STREAMS.get(env.STREAMS.idFromName(accountId)).revoke(tokenHash)
	}
	await run(env, 'DELETE FROM sessions WHERE token_hash=? AND account_id=?', hash, accountId)
}
security.delete('/api/hyena/security/sessions/:id', async (c) => {
	const { account: a } = await requireWeb(c)
	await revokeSession(c.env, c.req.param('id'), a.id)
	return c.json({})
})
security.delete('/api/hyena/security/applications/:id', async (c) => {
	const { account: a } = await requireWeb(c)
	const rows = await all<{ token_hash: string }>(
		c.env,
		'SELECT token_hash FROM oauth_tokens WHERE app_id=? AND account_id=?',
		c.req.param('id'),
		a.id
	)
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE app_id=? AND account_id=?').bind(
			Date.now(),
			c.req.param('id'),
			a.id
		),
		c.env.DB.prepare(
			'DELETE FROM push_subscriptions WHERE token_hash IN (SELECT token_hash FROM oauth_tokens WHERE app_id=? AND account_id=?)'
		).bind(c.req.param('id'), a.id),
	])
	for (const row of rows) await c.env.STREAMS.get(c.env.STREAMS.idFromName(a.id)).revoke(row.token_hash)
	return c.json({})
})

const encode = (b: Uint8Array) =>
	btoa(String.fromCharCode(...b))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
type Passkey = { id: string; account_id: string; public_key: string; counter: number; transports: string }
security.post('/api/hyena/security/passkeys/options', async (c) => {
	const input = await readInput(c.req.raw),
		a = await passwordConfirmation(c, input),
		keys = await all<Passkey>(c.env, 'SELECT * FROM passkeys WHERE account_id=?', a.id),
		options = await generateRegistrationOptions({
			rpName: c.env.INSTANCE_TITLE,
			rpID: new URL(c.env.PUBLIC_ORIGIN).hostname,
			userID: new Uint8Array(new TextEncoder().encode(a.id)),
			userName: a.username,
			attestationType: 'none',
			authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
			supportedAlgorithmIDs: [-7, -257],
			excludeCredentials: keys.map((k) => ({
				id: k.id,
				transports: parsed<AuthenticatorTransport[]>(k.transports, []),
			})),
		})
	return c.json({
		options,
		challenge: await challenge(c.env, a.id, 'passkey.register', {
			challenge: options.challenge,
			name: stringField(input, 'name', 'Passkey').slice(0, 100),
		}),
	})
})
security.post('/api/hyena/security/passkeys/verify', async (c) => {
	const input = await readInput(c.req.raw),
		{ account: a } = await requireWeb(c, input),
		ch = await consumeChallenge(c.env, stringField(input, 'challenge'), 'passkey.register', a.id)
	let verified
	try {
		verified = await verifyRegistrationResponse({
			response: object(input.response) as unknown as RegistrationResponseJSON,
			expectedChallenge: String(ch.data.challenge),
			expectedOrigin: c.env.PUBLIC_ORIGIN,
			expectedRPID: new URL(c.env.PUBLIC_ORIGIN).hostname,
			requireUserVerification: true,
			supportedAlgorithmIDs: [-7, -257],
		})
	} catch {
		throw new ApiError(422, 'Passkey verification failed')
	}
	if (!verified.verified || !verified.registrationInfo) throw new ApiError(422, 'Passkey verification failed')
	const credential = verified.registrationInfo.credential
	await run(
		c.env,
		'INSERT INTO passkeys(id,account_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)',
		credential.id,
		a.id,
		encode(credential.publicKey),
		credential.counter,
		JSON.stringify(credential.transports ?? []),
		String(ch.data.name),
		now()
	)
	return c.json({ id: credential.id })
})
security.delete('/api/hyena/security/passkeys/:id', async (c) => {
	const { account: a } = await requireWeb(c)
	await run(c.env, 'DELETE FROM passkeys WHERE id=? AND account_id=?', c.req.param('id'), a.id)
	return c.json({})
})
security.post('/api/hyena/passkeys/options', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	await throttle(c, 'passkey-login:' + c.req.header('CF-Connecting-IP'))
	const options = await generateAuthenticationOptions({
			rpID: new URL(c.env.PUBLIC_ORIGIN).hostname,
			userVerification: 'required',
		}),
		id = await challenge(c.env, null, 'passkey.login', { challenge: options.challenge })
	setCookie(c, 'hyena_passkey', id, { ...sessionCookie(c.env.PUBLIC_ORIGIN), maxAge: 300 })
	return c.json({ options })
})
security.post('/api/hyena/passkeys/verify', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	await throttle(c, 'passkey-login:' + c.req.header('CF-Connecting-IP'))
	const input = await readInput(c.req.raw),
		ch = await consumeChallenge(c.env, getCookie(c, 'hyena_passkey') ?? '', 'passkey.login'),
		response = object(input.response) as unknown as AuthenticationResponseJSON,
		key = await one<Passkey>(c.env, 'SELECT * FROM passkeys WHERE id=?', response.id)
	if (!key) throw new ApiError(401, 'Passkey verification failed')
	const a = await accountById(c.env, key.account_id)
	if (a.disabled || a.suspended || !a.approved || a.domain || (a.email && !a.email_confirmed))
		throw new ApiError(401, 'Passkey verification failed')
	let verified
	try {
		verified = await verifyAuthenticationResponse({
			response,
			expectedChallenge: String(ch.data.challenge),
			expectedOrigin: c.env.PUBLIC_ORIGIN,
			expectedRPID: new URL(c.env.PUBLIC_ORIGIN).hostname,
			requireUserVerification: true,
			credential: {
				id: key.id,
				publicKey: decode(key.public_key),
				counter: key.counter,
				transports: parsed<AuthenticatorTransport[]>(key.transports, []),
			},
		})
	} catch {
		throw new ApiError(401, 'Passkey verification failed')
	}
	if (!verified.verified) throw new ApiError(401, 'Passkey verification failed')
	if (
		!(
			await run(
				c.env,
				'UPDATE passkeys SET counter=? WHERE id=? AND counter=?',
				verified.authenticationInfo.newCounter,
				key.id,
				key.counter
			)
		).meta.changes
	)
		throw new ApiError(401, 'Passkey counter changed')
	await createSession(c, a)
	deleteCookie(c, 'hyena_passkey', sessionCookie(c.env.PUBLIC_ORIGIN))
	return c.json({ redirect: '/' })
})

security.get('/auth/password/new', (c) => {
	const csrf = randomToken()
	setCookie(c, 'hyena_form', csrf, { ...sessionCookie(c.env.PUBLIC_ORIGIN), maxAge: 600 })
	return c.html(
		page(
			'Reset password',
			`<h1>Reset password</h1><form method="post" action="/auth/password">${hidden('csrf', csrf)}<label>Email <input type="email" name="email" required></label><button>Send reset link</button></form>`
		)
	)
})
security.post('/auth/password', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	const input = await readInput(c.req.raw)
	if (!equal(stringField(input, 'csrf'), getCookie(c, 'hyena_form') ?? '') || !stringField(input, 'csrf'))
		throw new ApiError(403, 'Invalid form token')
	await throttle(c, 'password-reset:' + c.req.header('CF-Connecting-IP'))
	const a = await one<AccountRow>(
		c.env,
		"SELECT * FROM accounts WHERE domain='' AND lower(email)=? AND email_confirmed=1 AND disabled=0",
		stringField(input, 'email').toLowerCase()
	)
	if (a && c.env.EMAIL) {
		const token = randomToken()
		await c.env.DB.batch([
			c.env.DB.prepare("DELETE FROM email_tokens WHERE account_id=? AND purpose='password'").bind(a.id),
			c.env.DB.prepare(
				"INSERT INTO email_tokens(hash,account_id,purpose,expires_at,email) VALUES(?,?,'password',?,?)"
			).bind(await digest(token), a.id, Date.now() + 3600000, a.email!),
			c.env.DB.prepare("INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'email.send',?,?,?)").bind(
				'password:' + crypto.randomUUID(),
				JSON.stringify({
					to: a.email,
					subject: 'Reset your Hyena password',
					text: `Reset your password within one hour: ${c.env.PUBLIC_ORIGIN}/auth/password/edit?reset_password_token=${token}`,
				}),
				Date.now(),
				Date.now()
			),
		])
	}
	return c.html(
		page(
			'Check your email',
			'<h1>Check your email</h1><p>If this email belongs to a confirmed account, a reset link has been sent.</p>'
		)
	)
})
security.get('/auth/password/edit', (c) => {
	const csrf = randomToken()
	setCookie(c, 'hyena_form', csrf, { ...sessionCookie(c.env.PUBLIC_ORIGIN), maxAge: 600 })
	return c.html(
		page(
			'Choose a password',
			`<h1>Choose a password</h1><form method="post" action="/auth/password/update">${hidden('csrf', csrf)}${hidden('reset_password_token', c.req.query('reset_password_token') ?? '')}<label>New password <input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label><button>Change password</button></form>`
		)
	)
})
security.post('/auth/password/update', async (c) => {
	sameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN)
	const input = await readInput(c.req.raw)
	if (!equal(stringField(input, 'csrf'), getCookie(c, 'hyena_form') ?? '') || !stringField(input, 'csrf'))
		throw new ApiError(403, 'Invalid form token')
	await throttle(c, 'password-reset:' + c.req.header('CF-Connecting-IP'))
	const password = stringField(input, 'password')
	if (password.length < 12 || password.length > 256) throw new ApiError(422, 'Use 12–256 characters')
	const row = await c.env.DB.prepare(
		"DELETE FROM email_tokens WHERE hash=? AND purpose='password' AND expires_at>? AND email=(SELECT email FROM accounts WHERE id=email_tokens.account_id) RETURNING account_id"
	)
		.bind(await digest(stringField(input, 'reset_password_token')), Date.now())
		.first<{ account_id: string }>()
	if (!row) throw new ApiError(422, 'Reset link expired or was already used')
	await changePassword(c.env, row.account_id, password)
	return c.redirect('/login', 303)
})
