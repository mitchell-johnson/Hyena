import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { Accept, Reject, Follow, Person } from '@fedify/vocab'
import { createFederation, type InboxContext } from '@fedify/fedify'
import { getDocumentLoader } from '@fedify/vocab-runtime'
import type { Env } from '../src/types'
import { env, runtime, seed, json } from './support'
import { one, run } from '../src/data'
import { receive } from '../src/federation/receive'
import { D1KvStore } from '../src/federation/storage'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

async function pendingFollow() {
	const local = await seed('alice'),
		remote = new Person({
			id: new URL('https://remote.example/users/bob'),
			preferredUsername: 'bob',
			inbox: new URL('https://remote.example/inbox'),
		}),
		other = new Person({
			id: new URL('https://remote.example/users/mallory'),
			preferredUsername: 'mallory',
			inbox: new URL('https://remote.example/inbox'),
		}),
		documents = new Map([
			[remote.id!.href, await remote.toJsonLd()],
			[other.id!.href, await other.toJsonLd()],
		]),
		loader = vi.fn(async (url: string) => {
			if (!documents.has(url)) throw new Error('Unexpected object dereference: ' + url)
			return { contextUrl: null, documentUrl: url, document: documents.get(url)! }
		}),
		f = createFederation<Env>({
			origin: env.PUBLIC_ORIGIN,
			kv: new D1KvStore(env),
			contextLoaderFactory: () => getDocumentLoader(),
			documentLoaderFactory: () => loader,
		}),
		ctx = f.createContext(new URL(env.PUBLIC_ORIGIN), env) as InboxContext<Env>
	await run(
		env,
		'INSERT INTO accounts(id,username,domain,uri,inbox,created_at) VALUES(?,?,?,?,?,?)',
		'remote-bob',
		'bob',
		'remote.example',
		remote.id!.href,
		remote.inboxId!.href,
		new Date().toISOString()
	)
	const follow = () => json('/api/v1/accounts/remote-bob/follow', { token: local.token, method: 'POST', body: {} }),
		current = () =>
			one<{ id: string; activity_uri: string; state: string }>(
				env,
				'SELECT id,activity_uri,state FROM follows WHERE follower_id=? AND following_id=?',
				local.id,
				'remote-bob'
			)
	await follow()
	return { local, remote, other, ctx, loader, follow, current, original: (await current())! }
}

it.each([Accept, Reject])(
	'applies a URI-only %s to the exact stored Follow without fetching it',
	async (ResponseType) => {
		const { remote, ctx, loader, original, current } = await pendingFollow(),
			response = new ResponseType({
				id: new URL('https://remote.example/activities/response'),
				actor: remote.id,
				object: new URL(original.activity_uri),
			})
		await receive(ctx, response)
		await receive(ctx, response)
		expect(await current()).toEqual(ResponseType === Accept ? { ...original, state: 'accepted' } : null)
		expect(loader.mock.calls.map(([url]) => url)).toEqual([remote.id!.href])
	}
)

it('continues accepting embedded Follow responses without dereferencing the embedded object', async () => {
	const { local, remote, ctx, loader, original, current } = await pendingFollow()
	await receive(
		ctx,
		new Accept({
			id: new URL('https://remote.example/activities/embedded'),
			actor: remote.id,
			object: new Follow({
				id: new URL(original.activity_uri),
				actor: new URL(env.PUBLIC_ORIGIN + '/users/alice'),
				object: remote.id,
			}),
		})
	)
	expect((await current())?.state).toBe('accepted')
	expect(await json('/api/v1/accounts/relationships?id[]=remote-bob', { token: local.token })).toMatchObject([
		{ following: true, requested: false },
	])
	expect(loader.mock.calls.map(([url]) => url)).toEqual([remote.id!.href])
})

it.each([Accept, Reject])(
	'ignores %s from another actor and unknown object URIs without fetching them',
	async (ResponseType) => {
		const { remote, other, ctx, loader, original, current } = await pendingFollow()
		await receive(
			ctx,
			new ResponseType({
				id: new URL('https://remote.example/activities/wrong-actor'),
				actor: other.id,
				object: new URL(original.activity_uri),
			})
		)
		await receive(
			ctx,
			new ResponseType({
				id: new URL('https://remote.example/activities/unknown-request'),
				actor: remote.id,
				object: new URL('https://unrelated.example/private-object'),
			})
		)
		expect(await current()).toEqual(original)
		expect(loader.mock.calls.map(([url]) => url)).toEqual([other.id!.href, remote.id!.href])
	}
)

it('ignores old responses after unfollowing and following again', async () => {
	const { local, remote, ctx, loader, original, current, follow } = await pendingFollow()
	await json('/api/v1/accounts/remote-bob/unfollow', { token: local.token, method: 'POST', body: {} })
	await follow()
	const replacement = (await current())!
	expect(replacement.activity_uri).not.toBe(original.activity_uri)
	for (const ResponseType of [Accept, Reject]) {
		await receive(
			ctx,
			new ResponseType({
				id: new URL('https://remote.example/activities/stale-' + ResponseType.name),
				actor: remote.id,
				object: new URL(original.activity_uri),
			})
		)
		expect(await current()).toEqual(replacement)
	}
	await receive(
		ctx,
		new Accept({
			id: new URL('https://remote.example/activities/current'),
			actor: remote.id,
			object: new URL(replacement.activity_uri),
		})
	)
	expect(await current()).toEqual({ ...replacement, state: 'accepted' })
	expect(loader.mock.calls.every(([url]) => url === remote.id!.href)).toBe(true)
})
