import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { env, runtime, seed, request, json } from './support'
import { CONTENT_SECURITY_POLICY } from '../src/http'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

it.each([
	['com.tapbots.Ivory.25200:/request_token/example', 'query'],
	['https://client.example/callback?existing=value', 'query'],
	['https://client.example/callback', 'fragment'],
])('permits the registered %s callback and preserves OAuth state in %s mode', async (redirect, mode) => {
	const owner = await seed('owner')
	await env.DB.prepare('UPDATE oauth_apps SET redirect_uris=? WHERE id=?')
		.bind(JSON.stringify([redirect, 'https://unused.example/callback']), owner.app)
		.run()
	const input = {
		client_id: owner.app,
		redirect_uri: redirect,
		response_type: 'code',
		response_mode: mode,
		scope: 'read',
		state: 'opaque & state',
	}
	const consent = await request('/oauth/authorize?' + new URLSearchParams(input), { cookie: owner.cookie })
	const callback = new URL(redirect)
	const source = callback.origin === 'null' ? callback.protocol : callback.origin
	expect(consent.status).toBe(200)
	expect(consent.headers.get('Content-Security-Policy')).toBe(
		CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' ${source}`)
	)
	const post = (decision: string) =>
		request('/oauth/authorize', {
			method: 'POST',
			cookie: owner.cookie,
			headers: { Origin: env.PUBLIC_ORIGIN },
			body: { ...input, csrf: owner.csrf, decision },
		})
	const approved = await post('allow')
	expect(approved.status).toBe(303)
	const target = new URL(approved.headers.get('Location')!)
	const result = mode === 'fragment' ? new URLSearchParams(target.hash.slice(1)) : target.searchParams
	expect(result.get('state')).toBe(input.state)
	expect(target.protocol).toBe(callback.protocol)
	expect(target.host).toBe(callback.host)
	expect(target.pathname).toBe(callback.pathname)
	const token = await json<{ access_token: string }>('/oauth/token', {
		method: 'POST',
		body: {
			client_id: owner.app,
			client_secret: 'app-secret',
			grant_type: 'authorization_code',
			code: result.get('code'),
			redirect_uri: redirect,
		},
	})
	expect((await json('/api/v1/accounts/verify_credentials', { token: token.access_token })).id).toBe(owner.id)
	const denied = await post('deny')
	expect(denied.status).toBe(303)
	const deniedTarget = new URL(denied.headers.get('Location')!)
	const denial = mode === 'fragment' ? new URLSearchParams(deniedTarget.hash.slice(1)) : deniedTarget.searchParams
	expect(denial.get('error')).toBe('access_denied')
	expect(denial.get('state')).toBe(input.state)
})

it('keeps callback permissions off login, invalid requests and out-of-band consent', async () => {
	const owner = await seed('owner')
	const oob = 'urn:ietf:wg:oauth:2.0:oob'
	const redirects = [oob, 'https://*.example/callback', 'https://client.example;script-src/callback']
	await env.DB.prepare('UPDATE oauth_apps SET redirect_uris=? WHERE id=?')
		.bind(JSON.stringify(redirects), owner.app)
		.run()
	for (const redirect of [...redirects, 'https://unregistered.example/callback']) {
		const response = await request(
			'/oauth/authorize?' +
				new URLSearchParams({
					client_id: owner.app,
					redirect_uri: redirect,
					response_type: 'code',
					scope: 'read',
				}),
			{ cookie: owner.cookie }
		)
		expect(response.status).toBe(redirect === oob ? 200 : 400)
		expect(response.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY)
	}
	expect((await request('/login')).headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY)
})
