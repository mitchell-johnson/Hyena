import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { requireWeb } from './auth/security'
import { digest, randomToken } from './auth/crypto'
import { webSession } from './auth/access'
import { one, all, now, accountById, parsed, setting, object } from './data'
import { nextId } from './db'
import { seal, unseal } from './federation/keys'
import { accountJSON, statusJSON } from './serializers'
import { audienceSQL, visible } from './policy'
import { ApiError, escapeHtml, readInput } from './http'
import { push } from './push'
import { page } from './views'
import type { AppEnv, AccountRow, StatusRow } from './types'
export const web = new Hono<AppEnv>()
async function webToken(c: Context<AppEnv>) {
	const { account, session } = await requireWeb(c),
		hash = await digest(getCookie(c, 'hyena_session')!),
		row = await one<{ api_token_cipher: string | null; expires_at: number }>(
			c.env,
			'SELECT api_token_cipher,expires_at FROM sessions WHERE token_hash=?',
			hash
		)
	if (!row) throw new ApiError(401, 'Sign in to continue')
	if (row.api_token_cipher) {
		const token = await unseal<string>(c.env, row.api_token_cipher)
		if (
			await one(
				c.env,
				'SELECT 1 FROM oauth_tokens WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
				await digest(token),
				Date.now()
			)
		)
			return { account, session, token }
		await c.env.DB.prepare('UPDATE sessions SET api_token_cipher=NULL WHERE token_hash=? AND api_token_cipher=?')
			.bind(hash, row.api_token_cipher)
			.run()
	}
	const raw = randomToken(),
		id = await nextId(c.env.DB)
	await c.env.DB.prepare(
		"INSERT OR IGNORE INTO oauth_apps(id,name,client_id,secret_hash,redirect_uris,scopes,created_at) VALUES(?,'Hyena web','hyena-web',?,'[]','read write push profile admin:read admin:write',?)"
	)
		.bind(id, await digest(randomToken()), now())
		.run()
	const app = await one<{ id: string }>(c.env, "SELECT id FROM oauth_apps WHERE client_id='hyena-web'")
	await c.env.DB.batch([
		c.env.DB.prepare(
			'INSERT INTO oauth_tokens(token_hash,app_id,account_id,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?)'
		).bind(
			await digest(raw),
			app!.id,
			account.id,
			'read write push profile' +
				(['admin', 'moderator'].includes(account.role ?? '') ? ' admin:read admin:write' : ''),
			Date.now(),
			row.expires_at
		),
		c.env.DB.prepare('UPDATE sessions SET api_token_cipher=? WHERE token_hash=? AND api_token_cipher IS NULL').bind(
			await seal(c.env, raw),
			hash
		),
	])
	const saved = await one<{ api_token_cipher: string }>(
		c.env,
		'SELECT api_token_cipher FROM sessions WHERE token_hash=?',
		hash
	)
	const token = await unseal<string>(c.env, saved!.api_token_cipher)
	if (token !== raw)
		await c.env.DB.prepare('DELETE FROM oauth_tokens WHERE token_hash=?')
			.bind(await digest(raw))
			.run()
	return { account, session, token }
}
web.get('/api/hyena/session', async (c) => {
	const a = await webToken(c)
	return c.json({ account: await accountJSON(c.env, a.account, true), csrf: a.session.csrf, access_token: a.token })
})
web.put('/api/web/settings', async (c) => {
	const input = await readInput(c.req.raw),
		{ account: a } = await requireWeb(c, input),
		prefs = parsed<Record<string, unknown>>(a.preferences, {})
	prefs.web = object(input.data ?? input)
	await c.env.DB.prepare('UPDATE accounts SET preferences=? WHERE id=?').bind(JSON.stringify(prefs), a.id).run()
	return c.json({})
})
for (const method of ['post', 'put', 'delete'] as const)
	web[method]('/api/web/push_subscriptions' + (method === 'post' ? '' : '/:id'), async (c) => {
		const input = await readInput(c.req.raw)
		await requireWeb(c, input)
		const { token } = await webToken(c)
		return push.fetch(
			new Request(c.env.PUBLIC_ORIGIN + '/api/v1/push/subscription', {
				method: method.toUpperCase(),
				headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
				body: JSON.stringify(input),
			}),
			c.env,
			c.executionCtx
		)
	})
function shell(title: string, csrf = '') {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#173c32"><meta name="csrf-token" content="${escapeHtml(csrf)}"><title>${escapeHtml(title)} · Hyena</title><link rel="stylesheet" href="/assets/app.css"><link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/assets/app.js"></script></head><body><a class="skip" href="#content">Skip to content</a><div class="layout"><aside class="sidebar"><a class="brand" href="/">HYENA<span>your home on the fediverse</span></a><nav aria-label="Main"><a href="/" data-view="home">Home</a><a href="/public" data-view="public">Live feed</a><a href="/explore" data-view="explore">Explore</a><a href="/notifications" data-view="notifications">Notifications</a><a href="/conversations" data-view="conversations">Conversations</a><a href="/bookmarks" data-view="bookmarks">Bookmarks</a><a href="/favourites" data-view="favourites">Favourites</a><a href="/lists" data-view="lists">Lists</a><a href="/collections" data-view="collections">Collections</a><a href="/scheduled_statuses" data-view="scheduled">Scheduled posts</a><a href="/search" data-view="search">Search</a><a href="/annual_reports">Annual reports</a><a href="/settings" data-view="settings">Settings</a><a href="/admin" data-view="admin" hidden id="admin-link">Administration</a></nav><div id="identity"></div><a href="/about">About this instance</a></aside><main id="content" tabindex="-1"><header class="view-header"><h1 id="view-title">Home</h1><button id="refresh" class="quiet">Refresh</button></header><div id="message" role="status" aria-live="polite"></div><section id="composer" hidden></section><section id="view" aria-busy="true"><p class="muted">Loading…</p></section><button id="more" hidden>Load more</button></main><aside class="context"><h2>A little more human.</h2><p>Post a thought. Find your people. Keep the conversation going.</p><p id="instance-description"></p><a href="/settings/apps">Connect a Mastodon app</a><p class="muted">Media must be shorter than 60 seconds.</p><div id="announcements"></div></aside></div></body></html>`
}
for (const path of [
	'/',
	'/public',
	'/explore',
	'/notifications',
	'/conversations',
	'/bookmarks',
	'/favourites',
	'/lists',
	'/collections',
	'/collections/:id',
	'/scheduled_statuses',
	'/annual_reports',
	'/accounts/:id',
	'/statuses/:id',
	'/search',
	'/settings',
	'/settings/*',
	'/admin',
	'/tags/:tag',
])
	web.get(path, async (c) => {
		const session = await webSession(c)
		if (
			!session &&
			path !== '/public' &&
			path !== '/explore' &&
			path !== '/tags/:tag' &&
			path !== '/collections/:id' &&
			path !== '/'
		) {
			return c.redirect('/login')
		}
		if (!session && path === '/') {
			const owner = await one<AccountRow>(
				c.env,
				"SELECT * FROM accounts WHERE domain='' AND suspended=0 ORDER BY id LIMIT 1"
			)
			return c.html(
				page(
					c.env.INSTANCE_TITLE,
					`<h1>${escapeHtml(c.env.INSTANCE_TITLE)}</h1><p>${escapeHtml(c.env.INSTANCE_DESCRIPTION)}</p><nav><a href="/login">Sign in</a><a href="/public">Read the live feed</a>${c.env.REGISTRATIONS === 'open' || c.env.REGISTRATIONS === 'approved' ? '<a href="/auth/sign_up">Create account</a>' : ''}</nav>${owner ? `<p><a href="/@${escapeHtml(owner.username)}">@${escapeHtml(owner.username)}</a></p>` : '<a href="/setup">Create your owner account</a>'}<p><a href="/about">About</a> · <a href="/privacy-policy">Privacy</a></p>`
				)
			)
		}
		return c.html(shell(c.env.INSTANCE_TITLE, session?.csrf))
	})
web.get('/auth/sign_up', (c) =>
	c.html(
		page(
			'Create account',
			`<h1>Create an account</h1><form id="signup"><label>Username <input name="username" pattern="[A-Za-z0-9_]{1,30}" required autocomplete="username"></label><label>Email <input name="email" type="email" required autocomplete="email"></label><label>Password <input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label><label>Reason for joining <textarea name="reason" maxlength="1000"></textarea></label><input type="hidden" name="invite_code" value="${escapeHtml(c.req.query('invite_code') ?? '')}"><label><input type="checkbox" name="agreement" required> I agree to the <a href="/terms">terms</a> and <a href="/privacy-policy">privacy policy</a>.</label><button>Create account</button><p id="result" role="status"></p></form><script src="/assets/signup.js" defer></script>`
		)
	)
)
for (const [path, key, title] of [
	['/about', 'extended_description', 'About'],
	['/privacy-policy', 'privacy_policy', 'Privacy policy'],
	['/terms', 'terms_of_service', 'Terms of service'],
])
	web.get(path!, async (c) => {
		const value = await setting<unknown>(
			c.env,
			key!,
			key === 'extended_description'
				? c.env.INSTANCE_DESCRIPTION
				: 'Contact the administrator for the current instance policy.'
		)
		return c.html(
			page(
				title!,
				`<h1>${title}</h1><div>${typeof value === 'string' ? escapeHtml(value).replaceAll('\n', '<br>') : escapeHtml(JSON.stringify(value))}</div><p>Contact: ${escapeHtml(c.env.CONTACT_EMAIL ?? 'the instance administrator')}</p>`
			)
		)
	})
async function publicStatus(c: Context<AppEnv>, id: string, embed = false) {
	const session = await webSession(c),
		s = await one<StatusRow>(c.env, 'SELECT * FROM statuses WHERE id=?', id)
	if (
		!s ||
		!(await visible(c.env, s, embed ? null : (session?.account_id ?? null))) ||
		(embed && !['public', 'unlisted'].includes(s.visibility))
	)
		throw new ApiError(404, 'Record not found')
	return { s, json: await statusJSON(c.env, s, embed ? null : (session?.account_id ?? null)) }
}
web.get('/@:username/:id', async (c, next) => {
	if (c.req.param('id') === 'embed') return next()
	const { s, json } = await publicStatus(c, c.req.param('id'))
	if (json.account.username !== c.req.param('username') || !s.local) throw new ApiError(404, 'Record not found')
	if (/application\/(?:activity\+json|ld\+json)/.test(c.req.header('Accept') ?? ''))
		return c.redirect(String(json.uri), 302)
	if (await webSession(c)) return c.html(shell(c.env.INSTANCE_TITLE))
	c.header('Link', `<${json.uri}>; rel="alternate"; type="application/activity+json"`)
	const media = Array.isArray(json.media_attachments)
		? (json.media_attachments as { type: string; url: string; description: string | null }[])
		: []
	return c.html(
		page(
			'@' + json.account.username,
			`<h1><a href="/@${escapeHtml(json.account.username)}">${escapeHtml(json.account.display_name || json.account.username)}</a></h1><article>${s.spoiler_text ? `<details><summary>${escapeHtml(s.spoiler_text)}</summary>` : ''}${s.content}${media.map((m) => (m.type === 'image' ? `<img loading="lazy" style="max-width:100%" src="${escapeHtml(m.url)}" alt="${escapeHtml(m.description ?? '')}">` : `<${m.type === 'audio' ? 'audio' : 'video'} controls preload="none" style="max-width:100%" src="${escapeHtml(m.url)}"></${m.type === 'audio' ? 'audio' : 'video'}>`)).join('')}${s.spoiler_text ? '</details>' : ''}<p><time>${escapeHtml(s.created_at)}</time></p></article>`
		)
	)
})
web.get('/@:username', async (c) => {
	const session = await webSession(c),
		a = await one<AccountRow>(
			c.env,
			"SELECT * FROM accounts WHERE username=? AND domain='' AND suspended=0",
			c.req.param('username')!
		)
	if (!a) throw new ApiError(404, 'Record not found')
	if (session) return c.html(shell(c.env.INSTANCE_TITLE, session.csrf))
	const p = audienceSQL(null, 's'),
		rows = await all<StatusRow>(
			c.env,
			`SELECT s.* FROM statuses s WHERE account_id=? AND ${p.sql} ORDER BY sequence DESC LIMIT 20`,
			a.id,
			...p.binds
		)
	c.header('Link', `<${c.env.PUBLIC_ORIGIN}/users/${a.username}>; rel="alternate"; type="application/activity+json"`)
	return c.html(
		page(
			'@' + a.username,
			`<h1>${escapeHtml(a.display_name || a.username)}</h1><p>@${escapeHtml(a.username)}</p><div>${a.note}</div>${a.moved_to_id ? '<p>This account has moved.</p>' : ''}${rows.map((s) => `<article>${s.spoiler_text ? `<details><summary>${escapeHtml(s.spoiler_text)}</summary>` : ''}${s.content}${s.spoiler_text ? '</details>' : ''}<p><a href="/@${escapeHtml(a.username)}/${s.id}">${escapeHtml(s.created_at)}</a></p></article>`).join('')}`
		)
	)
})
web.get('/@:username/:id/embed', async (c) => {
	const { s, json } = await publicStatus(c, c.req.param('id'), true)
	if (json.account.username !== c.req.param('username')) throw new ApiError(404, 'Record not found')
	c.header(
		'Content-Security-Policy',
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; frame-ancestors *; base-uri 'none'"
	)
	return c.html(
		page(
			'@' + json.account.username,
			`<article><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(String(json.url))}">@${escapeHtml(json.account.username)}</a>${s.spoiler_text ? `<details><summary>${escapeHtml(s.spoiler_text)}</summary>` : ''}${s.content}${s.spoiler_text ? '</details>' : ''}</article>`
		)
	)
})
async function embedJSON(c: Context<AppEnv>, url: string) {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new ApiError(422, 'Invalid URL')
	}
	const match = /^\/@([^/]+)\/(\d+)$/.exec(parsed.pathname)
	if (parsed.origin !== c.env.PUBLIC_ORIGIN || !match)
		throw new ApiError(404, 'Only local public posts can be embedded')
	const { json } = await publicStatus(c, match[2]!, true)
	if (json.account.username !== match[1]) throw new ApiError(404, 'Record not found')
	const width = Math.max(200, Math.min(1000, Number(c.req.query('maxwidth')) || 400))
	return {
		type: 'rich',
		version: '1.0',
		author_name: json.account.display_name || json.account.username,
		author_url: json.account.url,
		provider_name: c.env.INSTANCE_TITLE,
		provider_url: c.env.PUBLIC_ORIGIN,
		cache_age: 300,
		html: `<iframe src="${escapeHtml(parsed.origin + parsed.pathname)}/embed" width="${width}" height="300" style="border:0" title="Mastodon post" loading="lazy"></iframe>`,
		width,
		height: 300,
	}
}
web.get('/api/oembed', async (c) => c.json(await embedJSON(c, c.req.query('url') ?? '')))
web.get('/api/web/embeds/:id', async (c) => {
	const { json } = await publicStatus(c, c.req.param('id'), true)
	return c.json(await embedJSON(c, String(json.url)))
})
web.get('/.well-known/host-meta', (c) =>
	c.body(
		`<?xml version="1.0"?><XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="lrdd" template="${escapeHtml(c.env.PUBLIC_ORIGIN)}/.well-known/webfinger?resource={uri}"/></XRD>`,
		200,
		{ 'Content-Type': 'application/xrd+xml' }
	)
)
web.get('/robots.txt', (c) =>
	c.text('User-agent: *\nDisallow: /api/\nDisallow: /settings\nDisallow: /admin\nDisallow: /auth/\n')
)
web.get('/manifest.webmanifest', (c) =>
	c.json({
		name: c.env.INSTANCE_TITLE,
		short_name: 'Hyena',
		start_url: '/',
		display: 'standalone',
		background_color: '#f4f5f0',
		theme_color: '#173c32',
		icons: [{ src: '/avatar.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
	})
)
