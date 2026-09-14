import { applyD1Migrations, reset } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { digest, randomToken } from '../src/auth/crypto'
import { env, json, request, runtime, seed } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

type Post = { id: string; content: string; account: { id: string } }
const remoteText = 'A followed person wrote this #fediverse'
const link = 'https://remote.example/article'

async function followedPost() {
	const owner = await seed('owner'),
		remote = await seed('remote'),
		post = await json<Post>('/api/v1/statuses', {
			token: remote.token,
			method: 'POST',
			body: { status: remoteText },
		})
	await json(`/api/v1/accounts/${remote.id}/follow`, { token: owner.token, method: 'POST', body: {} })
	const card = { url: link, title: 'A followed link', type: 'link', provider_name: 'Remote' }
	await env.DB.batch([
		env.DB.prepare(
			"UPDATE accounts SET domain='remote.example',uri='https://remote.example/users/remote' WHERE id=?"
		).bind(remote.id),
		env.DB.prepare('UPDATE statuses SET local=0,uri=?,url=?,card=? WHERE id=?').bind(
			'https://remote.example/users/remote/statuses/1',
			'https://remote.example/@remote/1',
			JSON.stringify(card),
			post.id
		),
		env.DB.prepare("UPDATE tags SET approved=1 WHERE name='fediverse'"),
		env.DB.prepare('INSERT INTO link_cards(url,data,approved,fetched_at) VALUES(?,?,1,?)').bind(
			link,
			JSON.stringify(card),
			new Date().toISOString()
		),
		env.DB.prepare("INSERT INTO trend_reviews(kind,item_id,approved,updated_at) VALUES('statuses',?,1,?)").bind(
			post.id,
			new Date().toISOString()
		),
	])
	return { owner, remote, post }
}

async function scopedToken(app: string, account: string | null, scopes: string) {
	const token = randomToken()
	await env.DB.prepare('INSERT INTO oauth_tokens(token_hash,app_id,account_id,scopes,created_at) VALUES(?,?,?,?,?)')
		.bind(await digest(token), app, account, scopes, Date.now())
		.run()
	return token
}

it('removes the live feed page and API for every visitor, including signed-in users and alternate filters', async () => {
	const { owner } = await followedPost()
	for (const path of [
		'/public',
		'/api/v1/timelines/public',
		'/api/v1/timelines/public?local=true',
		'/api/v1/timelines/public?remote=true',
		'/api/v1/timelines/public?only_media=true',
		'/api/v1/timelines/public?remote=true&only_media=1&limit=1',
	]) {
		for (const auth of [{}, { token: owner.token }, { cookie: owner.cookie }, { token: 'invalid' }]) {
			const response = await request(path, auth)
			expect(response.status, path).toBe(404)
			expect(await response.text()).not.toContain(remoteText)
		}
	}
	for (const auth of [{}, { cookie: owner.cookie }]) {
		const landing = await request('/', auth),
			html = await landing.text()
		expect(landing.status).toBe(200)
		expect(html).not.toContain('href="/public"')
		expect(html).not.toMatch(/live feed/i)
		expect(html).not.toContain(remoteText)
	}
	for (const version of [1, 2]) {
		expect(await json(`/api/v${version}/instance`)).toMatchObject({
			configuration: {
				timelines_access: {
					live_feeds: { local: 'disabled', remote: 'disabled' },
					hashtag_feeds: { local: 'authenticated', remote: 'authenticated' },
					trending_link_feeds: { local: 'authenticated', remote: 'authenticated' },
				},
			},
		})
	}
})

it('requires a local user and matching read scope for every remaining aggregate discovery API', async () => {
	const { owner, remote, post } = await followedPost(),
		appToken = await scopedToken(owner.app, null, 'read'),
		statusesToken = await scopedToken(owner.app, owner.id, 'read:statuses'),
		accountsToken = await scopedToken(owner.app, owner.id, 'read:accounts')
	for (const path of [
		'/api/v1/timelines/tag/fediverse',
		'/api/v1/timelines/link?url=' + encodeURIComponent(link),
		'/api/v1/trends',
		'/api/v1/trends/tags',
		'/api/v1/trends/links',
		'/api/v1/trends/statuses',
		'/api/v1/directory',
	]) {
		for (const auth of [
			{},
			{ cookie: owner.cookie },
			{ token: 'invalid' },
			{ token: appToken },
			{ token: remote.token },
		]) {
			const response = await request(path, auth)
			expect(response.status, path).toBe(401)
			expect(await response.text()).not.toContain(remoteText)
		}
		const token = path.endsWith('/directory') ? statusesToken : accountsToken
		expect((await request(path, { token })).status, path).toBe(403)
	}
	for (const path of ['/api/v1/timelines/tag/fediverse', '/api/v1/timelines/link?url=' + encodeURIComponent(link)]) {
		expect((await json<Post[]>(path, { token: statusesToken })).map((row) => row.id)).toEqual([post.id])
	}
	for (const path of ['/api/v1/trends', '/api/v1/trends/tags']) {
		expect(await json(path, { token: statusesToken })).toEqual([expect.objectContaining({ name: 'fediverse' })])
	}
	const links = await json<{ url: string; history: { uses: string }[] }[]>('/api/v1/trends/links', {
		token: statusesToken,
	})
	expect(links[0]).toMatchObject({ url: link })
	expect(links[0]?.history[0]?.uses).toBe('1')
	expect((await json<Post[]>('/api/v1/trends/statuses', { token: statusesToken })).map((row) => row.id)).toEqual([
		post.id,
	])
	expect((await json<{ id: string }[]>('/api/v1/directory', { token: accountsToken })).map((row) => row.id)).toContain(
		remote.id
	)
})

it('keeps Home private and populated while preserving public local profiles and individual posts', async () => {
	const { owner, remote, post } = await followedPost(),
		other = await seed('other'),
		localPost = await json<Post>('/api/v1/statuses', {
			token: owner.token,
			method: 'POST',
			body: { status: 'My intentionally public post' },
		})
	expect((await request('/api/v1/timelines/home')).status).toBe(401)
	const home = await json<Post[]>('/api/v1/timelines/home', { token: owner.token })
	expect(home.map((row) => row.id)).toEqual([localPost.id, post.id])
	expect(home.find((row) => row.id === post.id)?.account.id).toBe(remote.id)
	expect(await json('/api/v1/timelines/home', { token: other.token })).toEqual([])
	for (const path of ['/explore', '/tags/fediverse']) {
		const anonymous = await request(path)
		expect(anonymous.status, path).toBe(302)
		expect(anonymous.headers.get('Location')).toBe('/login')
		expect((await request(path, { cookie: owner.cookie })).status).toBe(200)
	}
	const profile = await request('/@owner'),
		profileHtml = await profile.text()
	expect(profile.status).toBe(200)
	expect(profileHtml).toContain('My intentionally public post')
	expect(profileHtml).not.toContain(remoteText)
	expect((await json<Post[]>(`/api/v1/accounts/${owner.id}/statuses`)).map((row) => row.id)).toEqual([localPost.id])
	expect(await json(`/api/v1/statuses/${localPost.id}`)).toMatchObject({ id: localPost.id })
	const publicPost = await request(`/@owner/${localPost.id}`)
	expect(publicPost.status).toBe(200)
	expect(await publicPost.text()).toContain('My intentionally public post')
})
