import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { Person } from '@fedify/vocab'
import * as federationModule from '../src/federation'
import { nextId } from '../src/db'
import { one, run } from '../src/data'
import type { AccountRow } from '../src/types'
import { env, runtime, seed, json } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

async function remoteAccount(username = 'mitche_nz', domain = 'remote.example') {
	const id = await nextId(env.DB)
	await run(
		env,
		'INSERT INTO accounts(id,username,domain,uri,url,inbox,created_at) VALUES(?,?,?,?,?,?,?)',
		id,
		username,
		domain,
		`https://${domain}/users/${username}`,
		`https://${domain}/@${username}`,
		`https://${domain}/inbox`,
		new Date().toISOString()
	)
	return (await one<AccountRow>(env, 'SELECT * FROM accounts WHERE id=?', id))!
}

async function accounts(path: string, token: string, q: string, extra = '') {
	const result = await json<{ id: string }[] | { accounts: { id: string }[] }>(
		`${path}?q=${encodeURIComponent(q)}${extra}`,
		{ token, bindings: { ...env, ACCOUNT_DOMAIN: 'example.test' } }
	)
	return Array.isArray(result) ? result : result.accounts
}

it('finds cached remote handles, profile URLs and local domain aliases through both search APIs', async () => {
	const viewer = await seed('alice'),
		remote = await remoteAccount()
	await remoteAccount('mitcheXnz')
	for (const path of ['/api/v1/accounts/search', '/api/v2/search']) {
		for (const query of [
			'mitche_nz',
			'mitche_nz@remote.example',
			'@mitche_nz@remote.example',
			'  @mitche_nz@REMOTE.EXAMPLE  ',
			remote.uri!,
			remote.url!,
		])
			expect(await accounts(path, viewer.token, query), query).toEqual([expect.objectContaining({ id: remote.id })])
		for (const query of ['@alice', 'alice@example.test', '@alice@hyena.test'])
			expect(await accounts(path, viewer.token, query), query).toEqual([expect.objectContaining({ id: viewer.id })])
	}
})

it('includes a resolved account when its canonical actor name differs from the searched alias', async () => {
	const viewer = await seed('alice'),
		remote = await remoteAccount()
	vi.spyOn(federationModule, 'resolveAccount').mockResolvedValue(remote)
	for (const path of ['/api/v1/accounts/search', '/api/v2/search'])
		expect(await accounts(path, viewer.token, '@old-name@handles.example', '&resolve=true&type=accounts')).toEqual([
			expect.objectContaining({ id: remote.id }),
		])
})

it('keeps resolved accounts subject to blocks, instance policy and following filters', async () => {
	const viewer = await seed('alice'),
		remote = await remoteAccount(),
		query = '@mitche_nz@remote.example'
	const searchBoth = (extra = '') =>
		Promise.all(
			['/api/v1/accounts/search', '/api/v2/search'].map((path) =>
				accounts(path, viewer.token, query, '&resolve=true&type=accounts' + extra)
			)
		)
	expect(await searchBoth('&following=true')).toEqual([[], []])
	await run(
		env,
		"INSERT INTO follows(id,follower_id,following_id,state,created_at) VALUES(?,?,?,'accepted',?)",
		await nextId(env.DB),
		viewer.id,
		remote.id,
		new Date().toISOString()
	)
	for (const result of await searchBoth('&following=true')) expect(result.map((a) => a.id)).toEqual([remote.id])
	await run(
		env,
		"INSERT INTO account_actions(id,account_id,target_id,kind,created_at) VALUES(?,?,?,'block',?)",
		await nextId(env.DB),
		remote.id,
		viewer.id,
		new Date().toISOString()
	)
	expect(await searchBoth()).toEqual([[], []])
	await run(env, 'DELETE FROM account_actions')
	await run(
		env,
		'INSERT INTO moderation_rules(id,kind,value,data,created_at) VALUES(?,\'domain_blocks\',?,\'{"severity":"suspend"}\',?)',
		await nextId(env.DB),
		remote.domain!,
		new Date().toISOString()
	)
	expect(await searchBoth()).toEqual([[], []])
})

it('returns a newly resolved actor in general search even when WebFinger uses a different domain', async () => {
	const viewer = await seed('alice'),
		actor = new Person({
			id: new URL('https://actor.example/users/canonical'),
			preferredUsername: 'canonical',
			inbox: new URL('https://actor.example/inbox'),
		}),
		lookupObject = vi.fn().mockResolvedValue(actor)
	vi.spyOn(federationModule, 'federation').mockResolvedValue({
		createContext: () => ({ data: env, lookupObject }),
	} as never)
	const result = await accounts('/api/v2/search', viewer.token, '@alias@handles.example', '&resolve=true')
	expect(result).toHaveLength(1)
	expect(result[0]).toMatchObject({ username: 'canonical', acct: 'canonical@actor.example' })
	expect(lookupObject).toHaveBeenCalledWith('@alias@handles.example')
})

it('preserves cached search results when remote lookup fails and avoids logging private search details', async () => {
	const viewer = await seed('alice'),
		remote = await remoteAccount(),
		warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
	vi.spyOn(federationModule, 'federation').mockResolvedValue({
		createContext: () => ({
			lookupObject: async () => {
				throw new TypeError('Upstream body contains private data')
			},
		}),
	} as never)
	expect(await accounts('/api/v2/search', viewer.token, remote.url!, '&resolve=true')).toEqual([
		expect.objectContaining({ id: remote.id }),
	])
	expect(warning).toHaveBeenCalledWith(JSON.stringify({ event: 'search_resolution_failed', type: 'TypeError' }))
	expect(JSON.stringify(warning.mock.calls)).not.toContain('private data')
})
