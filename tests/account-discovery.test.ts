import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { verifyRequest } from '@fedify/fedify'
import { Person, Image, PropertyValue } from '@fedify/vocab'
import { federation, resolveAccount } from '../src/federation'
import { env, runtime, seed, json } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

async function secureRemote(protectedProfile = false) {
	const local = await seed('alice'),
		ctx = (await federation(env)).createContext(new Request(env.PUBLIC_ORIGIN), env),
		localActor = await ctx.getActor('alice'),
		localDocument = await localActor!.toJsonLd(),
		icon = new Image({ id: new URL('https://1.1.1.1/profile/icon'), url: new URL('https://1.1.1.1/media/icon.png') }),
		header = new Image({
			id: new URL('https://1.1.1.1/profile/header'),
			url: new URL('https://1.1.1.1/media/header.png'),
		}),
		field = new PropertyValue({
			id: new URL('https://1.1.1.1/profile/field'),
			name: 'Website',
			value: '<a href="https://1.1.1.1/about">About Bob</a>',
		}),
		// A public IP keeps Fedify's SSRF validation enabled without DNS requests.
		// Every HTTP request below is intercepted; no external server is contacted.
		remote = new Person({
			id: new URL('https://1.1.1.1/users/bob'),
			preferredUsername: 'bob',
			inbox: new URL('https://1.1.1.1/inbox'),
			...(protectedProfile ? { icon: icon.id, image: header.id, attachments: [field.id!] } : {}),
		}),
		documents = new Map(
			await Promise.all(
				[remote, icon, header, field].map(async (object) => [object.id!.href, await object.toJsonLd()] as const)
			)
		),
		actorRequests: Request[] = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init),
			url = new URL(request.url)
		if (url.origin === 'https://1.1.1.1' && url.pathname === '/.well-known/webfinger') {
			expect(url.searchParams.get('resource')).toBe('acct:bob@1.1.1.1')
			return Response.json({
				subject: 'acct:bob@1.1.1.1',
				links: [{ rel: 'self', type: 'application/activity+json', href: remote.id!.href }],
			})
		}
		if (!documents.has(request.url)) throw new Error('Unexpected discovery request')
		actorRequests.push(request)
		const verified = await verifyRequest(request.clone(), {
			documentLoader: async (url) => ({ contextUrl: null, documentUrl: url, document: localDocument }),
		})
		if (!verified) return new Response('A signed request is required', { status: 401 })
		expect(verified.ownerId?.href).toBe(env.PUBLIC_ORIGIN + '/users/alice')
		expect(request.headers.has('Authorization')).toBe(false)
		return Response.json(documents.get(request.url), { headers: { 'Content-Type': 'application/activity+json' } })
	})
	return { local, ctx, remote, actorRequests }
}

it('resolves a secure-mode actor with the requesting local actor signature', async () => {
	const { ctx, remote, actorRequests } = await secureRemote()
	await expect(resolveAccount(env, remote.id!.href, ctx)).rejects.toThrow('Account could not be resolved')
	expect((await resolveAccount(env, remote.id!.href, ctx, 'alice')).uri).toBe(remote.id!.href)
	expect(actorRequests.some((request) => !request.headers.has('Signature'))).toBe(true)
	expect(actorRequests.some((request) => request.headers.has('Signature'))).toBe(true)
})

it.each(['/api/v1/accounts/search', '/api/v2/search&type=accounts', '/api/v2/search'])(
	'discovers an uncached secure-mode handle through %s',
	async (path) => {
		const { local, remote, actorRequests } = await secureRemote(),
			[route, extra = ''] = path.split('&'),
			result = await json<{ uri: string }[] | { accounts: { uri: string }[] }>(
				`${route}?q=${encodeURIComponent('@bob@1.1.1.1')}&resolve=true&${extra}`,
				{ token: local.token }
			),
			accounts = Array.isArray(result) ? result : result.accounts
		expect(accounts).toHaveLength(1)
		expect(accounts[0]?.uri).toBe(remote.id!.href)
		expect(actorRequests.length).toBeGreaterThan(0)
		expect(actorRequests.every((request) => request.headers.has('Signature'))).toBe(true)
	}
)

it.each(['/api/v1/accounts/search', '/api/v2/search&type=accounts', '/api/v2/search'])(
	'keeps signed discovery for URI-valued profile images and fields through %s',
	async (path) => {
		const { local, actorRequests } = await secureRemote(true),
			[route, extra = ''] = path.split('&'),
			result = await json<Record<string, unknown>[] | { accounts: Record<string, unknown>[] }>(
				`${route}?q=${encodeURIComponent('@bob@1.1.1.1')}&resolve=true&${extra}`,
				{ token: local.token }
			),
			accounts = Array.isArray(result) ? result : result.accounts
		expect(accounts).toHaveLength(1)
		expect(accounts[0]).toMatchObject({
			avatar: 'https://1.1.1.1/media/icon.png',
			header: 'https://1.1.1.1/media/header.png',
			fields: [
				{
					name: 'Website',
					value: '<a href="https://1.1.1.1/about" rel="nofollow noopener noreferrer">About Bob</a>',
					verified_at: null,
				},
			],
		})
		expect(actorRequests.map((request) => new URL(request.url).pathname)).toEqual([
			'/users/bob',
			'/profile/icon',
			'/profile/header',
			'/profile/field',
		])
		expect(actorRequests.every((request) => request.headers.has('Signature'))).toBe(true)
	}
)

it('keeps local and cached handle lookups independent of network discovery', async () => {
	const { local, ctx } = await secureRemote(),
		remote = await resolveAccount(env, '@bob@1.1.1.1', ctx, 'alice'),
		loader = vi.spyOn(ctx, 'getDocumentLoader'),
		fetch = vi.spyOn(globalThis, 'fetch').mockClear().mockRejectedValue(new Error('Discovery unavailable'))
	expect((await resolveAccount(env, 'alice@hyena.test', ctx, 'alice')).id).toBe(local.id)
	expect((await resolveAccount(env, '@bob@1.1.1.1', ctx, 'alice')).id).toBe(remote.id)
	expect(loader).not.toHaveBeenCalled()
	expect(fetch).not.toHaveBeenCalled()
})
