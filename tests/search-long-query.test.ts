import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { env, runtime, seed, json } from './support'
import { nextId } from '../src/db'
import { run } from '../src/data'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

async function remote(username: string, displayName: string, url: string) {
	const id = await nextId(env.DB)
	await run(
		env,
		'INSERT INTO accounts(id,username,domain,uri,url,inbox,display_name,created_at) VALUES(?,?,?,?,?,?,?,?)',
		id,
		username,
		'flipboard.com',
		'https://flipboard.com/actors/' + id,
		url,
		'https://flipboard.com/inbox',
		displayName,
		new Date().toISOString()
	)
	return id
}

it('finds complete long handles and profile URLs without truncating their distinguishing suffixes', async () => {
	const viewer = await seed('alice'),
		username = 'the-verge-on-artificial-intelligence-theverge',
		url = 'https://flipboard.com/@theverge/the-verge-on-artificial-intelligence-rkbtf55qz',
		id = await remote(username, 'The Verge on Artificial Intelligence', url)
	await remote(username + '-other', 'Another magazine', url.replace('rkbtf55qz', 'another'))
	await remote('unrelated-magazine', username + '@flipboard.co', url + '/another')
	for (const path of ['/api/v1/accounts/search', '/api/v2/search']) {
		for (const query of [username + '@flipboard.com', (username + '@flipboard.com').toUpperCase(), url]) {
			const response = await json<{ id: string }[] | { accounts: { id: string }[] }>(
				`${path}?q=${encodeURIComponent(query)}&limit=80`,
				{ token: viewer.token }
			)
			const accounts = Array.isArray(response) ? response : response.accounts
			expect(accounts.map((a) => a.id)).toEqual([id])
		}
	}
	const resolved = await json<{ id: string }[]>(
		`/api/v1/accounts/search?q=${encodeURIComponent(username + '@flipboard.com')}&resolve=true&limit=80`,
		{ token: viewer.token }
	)
	expect(resolved.map((a) => a.id)).toEqual([id])
})

it('matches multibyte display-name queries longer than fifty bytes', async () => {
	const viewer = await seed('alice'),
		query = '人工知能についての新しい技術と社会の対話',
		id = await remote('unicode', query, 'https://flipboard.com/@unicode')
	expect(query.length).toBeLessThan(50)
	expect(new TextEncoder().encode(query).length).toBeGreaterThan(50)
	const result = await json<{ accounts: { id: string }[] }>('/api/v2/search?q=' + encodeURIComponent(query), {
		token: viewer.token,
	})
	expect(result.accounts.map((a) => a.id)).toEqual([id])
})

it('searches complete long post text with literal percent, underscore and backslash characters', async () => {
	const viewer = await seed('alice'),
		query = 'Literal%_\\path ' + 'a'.repeat(50) + ' exact ending',
		post = await json<{ id: string }>('/api/v1/statuses', {
			token: viewer.token,
			method: 'POST',
			body: { status: 'Before ' + query + ' after', visibility: 'public' },
		})
	for (const text of [query.replace('%_\\', 'xx/'), query.replace('exact ending', 'different ending')])
		await json('/api/v1/statuses', {
			token: viewer.token,
			method: 'POST',
			body: { status: text, visibility: 'public' },
		})
	const result = await json<{ statuses: { id: string }[] }>(
		'/api/v2/search?type=statuses&q=' + encodeURIComponent(query.toUpperCase()),
		{ token: viewer.token }
	)
	expect(result.statuses.map((s) => s.id)).toEqual([post.id])
})

it('searches long hashtags case-insensitively while treating underscores literally', async () => {
	const viewer = await seed('alice'),
		name = 'literal_' + 'a'.repeat(50) + '_ending'
	for (const tag of [name, name.replace('_', 'x'), name.replace('_ending', '_other')])
		await run(env, 'INSERT INTO tags(name,display_name,created_at) VALUES(?,?,?)', tag, tag, new Date().toISOString())
	const result = await json<{ hashtags: { name: string }[] }>(
		'/api/v2/search?type=hashtags&q=' + encodeURIComponent('#' + name.toUpperCase()),
		{ token: viewer.token }
	)
	expect(result.hashtags.map((t) => t.name)).toEqual([name])
})
