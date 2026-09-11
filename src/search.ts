import { Hono } from 'hono'
import { isLocalAccountDomain } from './identity'
import { authenticate, optionalAccount } from './auth/access'
import { all, one, run, pageLimit, accountById } from './data'
import { ApiError } from './http'
import { accountJSON, statusJSON } from './serializers'
import { allowedAccountSQL, limitedAccountSQL } from './moderation-policy'
import { audienceSQL } from './policy'
import { tagJSON } from './organize'
import { federation, resolveAccount } from './federation'
import { persistActor, persistStatus } from './federation/receive'
import { isActor } from '@fedify/vocab'
import type { AppEnv, AccountRow, StatusRow } from './types'
export const search = new Hono<AppEnv>()
const like = (s: string) => '%' + s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%'
async function accountSearch(
	env: Parameters<typeof all>[0],
	q: string,
	viewer: string | null,
	limit: number,
	following = false,
	offset = 0,
	resolvedId: string | null = null
) {
	const handle = q.replace(/^@/, ''),
		parts = handle.split('@'),
		localUsername = parts.length === 2 && isLocalAccountDomain(env, parts[1]) ? parts[0]! : null
	return all<AccountRow>(
		env,
		`SELECT a.* FROM accounts a WHERE a.suspended=0 AND ${allowedAccountSQL()} AND (a.username LIKE ? ESCAPE '\\' OR a.display_name LIKE ? ESCAPE '\\' OR (a.username||'@'||a.domain) LIKE ? ESCAPE '\\' OR (a.domain='' AND a.username=?) OR a.uri=? OR a.url=? OR a.id=?) AND NOT EXISTS(SELECT 1 FROM account_actions b WHERE b.kind='block' AND ((b.account_id=? AND b.target_id=a.id) OR (b.target_id=? AND b.account_id=a.id))) ${following ? "AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=a.id AND f.state='accepted')" : ''} ORDER BY a.id=? DESC,a.username=? DESC,a.username,a.id LIMIT ? OFFSET ?`,
		like(handle),
		like(q),
		like(handle),
		localUsername,
		q,
		q,
		resolvedId,
		viewer,
		viewer,
		...(following ? [viewer] : []),
		resolvedId,
		handle,
		limit,
		offset
	)
}
function resolutionFailed(error: unknown) {
	// Remote discovery is best effort. Keep cached search usable if a server is
	// unavailable without recording the user's query or a remote response body.
	console.warn(
		JSON.stringify({ event: 'search_resolution_failed', type: error instanceof Error ? error.name : 'Error' })
	)
}
search.get('/api/v1/accounts/lookup', async (c) => {
	const acct = (c.req.query('acct') ?? '').replace(/^@/, ''),
		parts = acct.split('@'),
		domain = isLocalAccountDomain(c.env, parts[1]) ? '' : parts[1]!
	const a = await one<AccountRow>(
		c.env,
		`SELECT * FROM accounts a WHERE username=? AND domain=? AND suspended=0 AND ${allowedAccountSQL()}`,
		parts[0] ?? '',
		domain
	)
	if (!a) throw new ApiError(404, 'Record not found')
	return c.json(await accountJSON(c.env, a))
})
search.get('/api/v1/accounts/search', async (c) => {
	await authenticate(c, 'read:accounts')
	const q = (c.req.query('q') ?? '').trim()
	if (!q || q.length > 500) throw new ApiError(422, 'Invalid search query')
	const resolved =
		c.req.query('resolve') === 'true' && /[@:/]/.test(q)
			? await resolveAccount(c.env, q, undefined, c.get('account').username).catch((error) => {
					resolutionFailed(error)
					return null
				})
			: null
	return c.json(
		await Promise.all(
			(
				await accountSearch(
					c.env,
					q,
					c.get('account').id,
					pageLimit(c, 80),
					c.req.query('following') === 'true',
					0,
					resolved?.id
				)
			).map((a) => accountJSON(c.env, a))
		)
	)
})
search.get('/api/v2/search', async (c) => {
	await authenticate(c, 'read:search')
	const viewer = c.get('account').id,
		q = (c.req.query('q') ?? '').trim(),
		type = c.req.query('type'),
		limit = pageLimit(c, 40),
		offset = Math.max(0, Math.min(10000, Number(c.req.query('offset') ?? 0)))
	if (
		!q ||
		q.length > 500 ||
		!Number.isInteger(offset) ||
		(type && !['accounts', 'statuses', 'hashtags'].includes(type))
	)
		throw new ApiError(422, 'Invalid search')
	let resolvedId: string | null = null
	if (c.req.query('resolve') === 'true' && /^(https:\/\/|@?[^\s@]+@)/.test(q)) {
		try {
			if (type === 'accounts') resolvedId = (await resolveAccount(c.env, q, undefined, c.get('account').username)).id
			else {
				const ctx = (await federation(c.env)).createContext(new URL(c.env.PUBLIC_ORIGIN), c.env),
					documentLoader = await ctx.getDocumentLoader({ identifier: c.get('account').username }),
					found = await ctx.lookupObject(q, { documentLoader })
				if (found && isActor(found)) resolvedId = (await persistActor(ctx, found, documentLoader)).id
				else if (found?.attributionId) {
					const actor = await ctx.lookupObject(found.attributionId, { documentLoader })
					if (actor && isActor(actor)) await persistStatus(ctx, found, await persistActor(ctx, actor, documentLoader))
				}
			}
		} catch (error) {
			resolutionFailed(error)
		}
	}
	const accounts =
			!type || type === 'accounts'
				? await Promise.all(
						(await accountSearch(c.env, q, viewer, limit, c.req.query('following') === 'true', offset, resolvedId)).map(
							(a) => accountJSON(c.env, a)
						)
					)
				: [],
		p = audienceSQL(viewer),
		account = c.req.query('account_id'),
		rows =
			!type || type === 'statuses'
				? await all<StatusRow>(
						c.env,
						`SELECT * FROM statuses WHERE ${p.sql} AND (text LIKE ? ESCAPE '\\' OR uri=? OR url=?) AND (account_id=? OR EXISTS(SELECT 1 FROM interactions i WHERE i.status_id=statuses.id AND i.account_id=?) OR EXISTS(SELECT 1 FROM status_recipients r WHERE r.status_id=statuses.id AND r.account_id=?) OR EXISTS(SELECT 1 FROM accounts a WHERE a.id=statuses.account_id AND a.indexable=1)) ${account ? 'AND account_id=?' : ''} ORDER BY sequence DESC LIMIT ? OFFSET ?`,
						...p.binds,
						like(q),
						q,
						q,
						viewer,
						viewer,
						viewer,
						...(account ? [account] : []),
						limit,
						offset
					)
				: []
	const hashtags =
		!type || type === 'hashtags'
			? await Promise.all(
					(
						await all<{ name: string }>(
							c.env,
							"SELECT name FROM tags WHERE name LIKE ? ESCAPE '\\' AND usable=1 ORDER BY name LIMIT ? OFFSET ?",
							like(q.replace(/^#/, '')),
							limit,
							offset
						)
					).map((t) => tagJSON(c.env, t.name, viewer))
				)
			: []
	return c.json({ accounts, statuses: await Promise.all(rows.map((s) => statusJSON(c.env, s, viewer))), hashtags })
})
search.get('/api/v1/directory', async (c) => {
	const viewer = await optionalAccount(c),
		offset = Number(c.req.query('offset') ?? 0)
	if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new ApiError(422, 'Invalid offset')
	const order = c.req.query('order') === 'new' ? 'created_at' : 'last_seen_at'
	const rows = await all<AccountRow>(
		c.env,
		`SELECT * FROM accounts a WHERE discoverable=1 AND suspended=0 AND ${allowedAccountSQL()} AND NOT ${limitedAccountSQL()} ${c.req.query('local') === 'true' ? "AND domain=''" : ''} AND NOT EXISTS(SELECT 1 FROM account_actions b WHERE b.account_id=? AND b.target_id=a.id AND b.kind='block') ORDER BY ${order} DESC LIMIT ? OFFSET ?`,
		viewer,
		pageLimit(c, 80),
		offset
	)
	return c.json(await Promise.all(rows.map((a) => accountJSON(c.env, a))))
})
for (const v of [1, 2])
	search.get(`/api/v${v}/suggestions`, async (c) => {
		await authenticate(c, 'read:accounts')
		const owner = c.get('account').id,
			rows = await all<AccountRow>(
				c.env,
				`SELECT * FROM accounts a WHERE discoverable=1 AND suspended=0 AND ${allowedAccountSQL()} AND NOT ${limitedAccountSQL()} AND id<>? AND NOT EXISTS(SELECT 1 FROM follows WHERE follower_id=? AND following_id=a.id) AND NOT EXISTS(SELECT 1 FROM account_actions x WHERE x.account_id=? AND x.target_id=a.id AND x.kind IN ('block','mute','dismiss_suggestion')) ORDER BY last_seen_at DESC LIMIT ?`,
				owner,
				owner,
				owner,
				pageLimit(c, 80)
			)
		const accounts = await Promise.all(rows.map((a) => accountJSON(c.env, a)))
		return c.json(
			v === 1
				? accounts
				: accounts.map((a) => ({ source: 'past_interactions', sources: ['past_interactions'], account: a }))
		)
	})
search.delete('/api/v1/suggestions/:id', async (c) => {
	await authenticate(c, 'read:accounts')
	await accountById(c.env, c.req.param('id'))
	await run(
		c.env,
		"INSERT OR IGNORE INTO account_actions(id,account_id,target_id,kind,created_at) VALUES(?,?,?,'dismiss_suggestion',?)",
		crypto.randomUUID(),
		c.get('account').id,
		c.req.param('id'),
		new Date().toISOString()
	)
	return c.json({})
})
