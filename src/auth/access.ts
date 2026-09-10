import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { ApiError } from '../http'
import type { AccountRow, AppEnv, Env, TokenRow } from '../types'
import { digest } from './crypto'
import { permits } from './scopes'

export async function lookupToken(env: Env, raw: string | undefined): Promise<TokenRow | null> {
	if (!raw || raw.length > 256) return null
	return env.DB.prepare(
		'SELECT * FROM oauth_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)'
	)
		.bind(await digest(raw), Date.now())
		.first<TokenRow>()
}
export async function authenticate(c: Context<AppEnv>, scope?: string, user = true): Promise<TokenRow> {
	const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(c.req.header('Authorization') ?? '')
	const token = await lookupToken(c.env, match?.[1])
	if (!token || (user && !token.account_id)) throw new ApiError(401, 'The access token is invalid')
	if (scope && !permits(token.scopes, scope)) throw new ApiError(403, 'This action is outside the authorized scopes')
	c.set('token', token)
	if (token.account_id) {
		const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
			.bind(token.account_id)
			.first<AccountRow>()
		if (!account || account.disabled || account.suspended || account.domain)
			throw new ApiError(401, 'The access token is invalid')
		if (
			(!account.approved || (account.email && !account.email_confirmed)) &&
			!/^\/api\/v1\/(emails\/|accounts\/verify_credentials$)/.test(c.req.path)
		)
			throw new ApiError(
				403,
				!account.approved ? 'Your account is awaiting approval' : 'Confirm your email address before continuing'
			)
		c.set('account', account)
		const today = new Date().toISOString().slice(0, 10)
		if ((account.last_seen_at ?? '').slice(0, 10) !== today)
			c.executionCtx.waitUntil(
				c.env.DB.batch([
					c.env.DB.prepare('UPDATE accounts SET last_seen_at=? WHERE id=?').bind(new Date().toISOString(), account.id),
					c.env.DB.prepare(
						"INSERT OR IGNORE INTO activity_metrics(day,account_id,kind,total) VALUES(?,?,'active',1)"
					).bind(today, account.id),
				])
			)
	}
	return token
}
export async function optionalAccount(c: Context<AppEnv>): Promise<string | null> {
	if (!c.req.header('Authorization')) return null
	return (await authenticate(c, 'read:statuses')).account_id
}
export async function webSession(c: Context<AppEnv>): Promise<{ account_id: string; csrf: string } | null> {
	const token = getCookie(c, 'hyena_session')
	if (!token || token.length > 256) return null
	return c.env.DB.prepare(
		'SELECT s.account_id, s.csrf FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled=0 AND a.suspended=0 AND a.approved=1 AND (a.email IS NULL OR a.email_confirmed=1)'
	)
		.bind(await digest(token), Date.now())
		.first()
}
