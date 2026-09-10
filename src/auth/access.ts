import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { ApiError } from '../http'
import type { AccountRow, AppEnv, Env, TokenRow } from '../types'
import { digest } from './crypto'
import { permits } from './scopes'

export async function lookupToken(env: Env, raw: string | undefined): Promise<TokenRow | null> {
	if (!raw || raw.length > 256) return null
	return env.DB.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ? AND revoked_at IS NULL')
		.bind(await digest(raw))
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
		if (!account) throw new ApiError(401, 'The access token is invalid')
		c.set('account', account)
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
	return c.env.DB.prepare('SELECT account_id, csrf FROM sessions WHERE token_hash = ? AND expires_at > ?')
		.bind(await digest(token), Date.now())
		.first()
}
