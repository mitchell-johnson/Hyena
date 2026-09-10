import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect } from 'vitest'
import worker from '../src/index'
import { resolveAccount } from '../src/federation'
import { env, runtime, seed, request, json } from './support'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

it('serves profile and post URLs containing @ without exposing private posts or accepting another author', async () => {
	const alice = await seed('alice')
	await seed('bob')
	const bindings = { ...env, ACCOUNT_DOMAIN: 'example.test' }
	const profile = await request('/@alice', { bindings })
	expect(profile.status).toBe(200)
	expect(await profile.text()).toContain('@alice@example.test')
	const post = await json<{ id: string }>('/api/v1/statuses', {
		bindings,
		token: alice.token,
		method: 'POST',
		body: { status: 'A public post', visibility: 'public' },
	})
	expect((await request(`/@alice/${post.id}`, { bindings })).status).toBe(200)
	expect((await request(`/@alice/${post.id}/embed`, { bindings })).status).toBe(200)
	expect((await request(`/@bob/${post.id}`, { bindings })).status).toBe(404)
	expect((await request('/@missing', { bindings })).status).toBe(404)
	const privatePost = await json<{ id: string }>('/api/v1/statuses', {
		bindings,
		token: alice.token,
		method: 'POST',
		body: { status: 'Private post', visibility: 'private' },
	})
	expect((await request(`/@alice/${privatePost.id}`, { bindings })).status).toBe(404)
	expect((await request(`/@alice/${privatePost.id}/embed`, { bindings })).status).toBe(404)
})

it('discovers the canonical account domain from either host while retaining the web actor identity', async () => {
	await seed('alice')
	const bindings = { ...env, ACCOUNT_DOMAIN: 'example.test' }
	for (const host of ['example.test', 'hyena.test']) {
		for (const resource of ['acct:alice@example.test', 'acct:alice@hyena.test', 'https://hyena.test/users/alice']) {
			const ctx = createExecutionContext()
			let response = await worker.fetch(
				new Request(`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`),
				bindings,
				ctx
			)
			await waitOnExecutionContext(ctx)
			if (host === 'example.test') {
				expect(response.status).toBe(307)
				expect(response.headers.get('Location')).toBe(
					`https://hyena.test/.well-known/webfinger?resource=${encodeURIComponent(resource)}`
				)
				const redirectedContext = createExecutionContext()
				response = await worker.fetch(new Request(response.headers.get('Location')!), bindings, redirectedContext)
				await waitOnExecutionContext(redirectedContext)
			}
			expect(response.status, `${host}: ${resource}`).toBe(200)
			const finger = await response.json<{
				subject: string
				aliases: string[]
				links: { rel: string; href: string }[]
			}>()
			expect(finger.subject).toBe(resource.startsWith('acct:') ? 'acct:alice@example.test' : resource)
			if (!resource.startsWith('acct:')) expect(finger.aliases).toContain('acct:alice@example.test')
			expect(finger.links.find((link) => link.rel === 'self')?.href).toBe('https://hyena.test/users/alice')
		}
	}
	const actor = await json<{ id: string; inbox: string }>('/users/alice', {
		bindings,
		headers: { Accept: 'application/activity+json' },
	})
	expect(actor.id).toBe('https://hyena.test/users/alice')
	expect(actor.inbox).toBe('https://hyena.test/users/alice/inbox')
	expect((await request('/.well-known/webfinger?resource=acct:alice@unrelated.test', { bindings })).status).toBe(404)
	expect((await request('/.well-known/webfinger?resource=acct:missing@example.test', { bindings })).status).toBe(404)
})

it('looks up both local handle forms, advertises the account domain, and prevents blocking either local domain', async () => {
	const alice = await seed('alice')
	const bindings = { ...env, ACCOUNT_DOMAIN: 'example.test' }
	for (const handle of ['alice', 'alice@example.test', 'alice@hyena.test']) {
		expect((await resolveAccount(bindings, handle)).id).toBe(alice.id)
		expect((await json<{ id: string }>(`/api/v1/accounts/lookup?acct=${handle}`, { bindings })).id).toBe(alice.id)
	}
	expect((await json<{ domain: string }>('/api/v2/instance', { bindings })).domain).toBe('example.test')
	expect((await json<{ uri: string }>('/api/v1/instance', { bindings })).uri).toBe('example.test')
	for (const domain of ['example.test', 'hyena.test']) {
		expect(
			(
				await request('/api/v1/domain_blocks', {
					bindings,
					token: alice.token,
					method: 'POST',
					body: { domain },
				})
			).status
		).toBe(422)
	}
})
