import { env as runtimeEnv } from 'cloudflare:workers'
import {
	applyD1Migrations,
	createExecutionContext,
	waitOnExecutionContext,
	reset,
	evictDurableObject,
	createMessageBatch,
	getQueueResult,
} from 'cloudflare:test'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { D1Migration } from '@cloudflare/vitest-plugin'
import worker from '../src/index'
import type { Env, JobMessage } from '../src/types'
import { digest, randomToken } from '../src/auth/crypto'
import { nextId } from '../src/db'
import { consume, executeJob, publishDue, sweep } from '../src/jobs'

const env = runtimeEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_FILES: Record<string, string> }
let queued: { version: 1; id: string }[] = []
function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		...env,
		JOBS: {
			send: async (body: { version: 1; id: string }) => {
				queued.push(body)
			},
		} as unknown as Env['JOBS'],
		...overrides,
	}
}
async function request(path: string, init: RequestInit = {}, bindings = testEnv()) {
	const ctx = createExecutionContext()
	const response = await worker.fetch(new Request(env.PUBLIC_ORIGIN + path, init), bindings, ctx)
	await waitOnExecutionContext(ctx)
	return response
}
async function json(path: string, body: unknown, token?: string, extra: Record<string, string> = {}) {
	return request(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
		body: JSON.stringify(body),
	})
}

async function encodedInput(path: string, values: Record<string, unknown>, encoding: string) {
	if (encoding === 'JSON') return json(path, values)
	const body = encoding === 'multipart' ? new FormData() : new URLSearchParams()
	for (const [key, value] of Object.entries(values))
		if (value !== null && value !== undefined) body.append(key, String(value))
	return request(path, { method: 'POST', body })
}
const cookie = (response: Response, name: string) =>
	response.headers
		.getSetCookie()
		.find((v) => v.startsWith(name + '='))!
		.split(';')[0]!
const csrf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!

async function seed(scopes = 'read write profile') {
	const id = await nextId(env.DB),
		appId = await nextId(env.DB),
		raw = randomToken()
	await env.DB.batch([
		env.DB.prepare('INSERT INTO accounts(id,username,password_hash,created_at) VALUES(?,?,?,?)').bind(
			id,
			'owner',
			'unused',
			new Date().toISOString()
		),
		env.DB.prepare(
			'INSERT INTO oauth_apps(id,name,client_id,secret_hash,redirect_uris,scopes,created_at) VALUES(?,?,?,?,?,?,?)'
		).bind(
			appId,
			'Test app',
			'client',
			await digest('secret'),
			'["hyena-test://callback"]',
			scopes,
			new Date().toISOString()
		),
		env.DB.prepare('INSERT INTO oauth_tokens(token_hash,app_id,account_id,scopes,created_at) VALUES(?,?,?,?,?)').bind(
			await digest(raw),
			appId,
			id,
			scopes,
			Date.now()
		),
	])
	return { id, appId, raw }
}
beforeEach(async () => {
	queued = []
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
afterEach(async () => {
	await reset()
})

describe('owner and OAuth', () => {
	it.each(['JSON', 'URL-encoded', 'multipart'])(
		'completes setup, login, consent, PKCE exchange, replay rejection and revocation with %s input',
		async (encoding) => {
			const setup = await request('/setup'),
				setupCookie = cookie(setup, 'hyena_form')
			const setupForm = new URLSearchParams({
				csrf: csrf(await setup.text()),
				setup_token: env.SETUP_TOKEN!,
				username: 'Owner',
				password: 'correct-horse-battery-42',
			})
			const created = await request('/setup', {
				method: 'POST',
				headers: { Origin: env.PUBLIC_ORIGIN, Cookie: setupCookie },
				body: setupForm,
			})
			expect(created.status).toBe(303)
			expect((await request('/setup')).headers.get('Location')).toBe('/login')
			const login = await request('/login'),
				loginCookie = cookie(login, 'hyena_form')
			const signedIn = await request('/login', {
				method: 'POST',
				headers: { Origin: env.PUBLIC_ORIGIN, Cookie: loginCookie },
				body: new URLSearchParams({
					csrf: csrf(await login.text()),
					username: 'owner',
					password: 'correct-horse-battery-42',
				}),
			})
			expect(signedIn.status).toBe(303)
			const session = cookie(signedIn, 'hyena_session')
			const registered = await encodedInput(
				'/api/v1/apps',
				{
					client_name: 'Test app',
					redirect_uris: 'hyena-test://callback',
					scopes: 'read write profile',
				},
				encoding
			)
			expect(registered.status).toBe(200)
			const app = await registered.json<{ client_id: string; client_secret: string }>()
			const verifier = randomToken(),
				params = new URLSearchParams({
					client_id: app.client_id,
					redirect_uri: 'hyena-test://callback',
					response_type: 'code',
					scope: 'read write profile',
					state: 'opaque state',
					code_challenge: await digest(verifier),
					code_challenge_method: 'S256',
				})
			const consent = await request('/oauth/authorize?' + params, { headers: { Cookie: session } })
			expect(consent.status).toBe(200)
			params.set('csrf', csrf(await consent.text()))
			params.set('decision', 'allow')
			const approved = await request('/oauth/authorize', {
				method: 'POST',
				headers: { Origin: env.PUBLIC_ORIGIN, Cookie: session },
				body: params,
			})
			expect(approved.status).toBe(303)
			const location = new URL(approved.headers.get('Location')!)
			expect(location.searchParams.get('state')).toBe('opaque state')
			const exchange = {
				...app,
				grant_type: 'authorization_code',
				code: location.searchParams.get('code'),
				redirect_uri: 'hyena-test://callback',
				code_verifier: verifier,
			}
			expect((await encodedInput('/oauth/token', { ...exchange, code_verifier: randomToken() }, encoding)).status).toBe(
				400
			)
			const tokens = await Promise.all([
				encodedInput('/oauth/token', exchange, encoding),
				encodedInput('/oauth/token', exchange, encoding),
			])
			expect(tokens.map((r) => r.status).sort()).toEqual([200, 400])
			const token = await tokens.find((r) => r.status === 200)!.json<{ access_token: string }>()
			const account = await request('/api/v1/accounts/verify_credentials', {
				headers: { Authorization: `Bearer ${token.access_token}` },
			})
			expect(account.status).toBe(200)
			const accountBody = await account.json<Record<string, unknown>>()
			expect(accountBody.username).toBe('owner')
			expect(accountBody.password_hash).toBeUndefined()
			expect((await encodedInput('/oauth/revoke', { ...app, token: token.access_token }, encoding)).status).toBe(200)
			expect(
				(
					await request('/api/v1/accounts/verify_credentials', {
						headers: { Authorization: `Bearer ${token.access_token}` },
					})
				).status
			).toBe(401)
		}
	)
	it('rejects CSRF, unsafe redirects, scope escalation and app-only posting', async () => {
		expect(
			(
				await request('/setup', {
					method: 'POST',
					headers: { Origin: 'https://evil.test' },
					body: new URLSearchParams({}),
				})
			).status
		).toBe(403)
		expect((await json('/api/v1/apps', { client_name: 'evil', redirect_uris: 'javascript:alert(1)' })).status).toBe(422)
		await seed('read')
		const tokenResponse = await json('/oauth/token', {
			client_id: 'client',
			client_secret: 'secret',
			grant_type: 'client_credentials',
			scope: 'read',
		})
		expect(tokenResponse.status).toBe(200)
		const token = await tokenResponse.json<{ access_token: string }>()
		expect((await json('/api/v1/statuses', { status: 'no' }, token.access_token)).status).toBe(401)
		expect(
			(
				await json('/oauth/token', {
					client_id: 'client',
					client_secret: 'secret',
					grant_type: 'client_credentials',
					scope: 'write',
				})
			).status
		).toBe(400)
		const badRedirect = new URLSearchParams({
			client_id: 'client',
			redirect_uri: 'https://evil.test',
			response_type: 'code',
			scope: 'read',
		})
		expect((await request('/oauth/authorize?' + badRedirect)).status).toBe(400)
	})
})

describe('R2 media pipeline', () => {
	const bytes = (name: string) => Uint8Array.from(atob(env.TEST_FILES[name]!), (c) => c.charCodeAt(0))
	const png = Uint8Array.from(
		atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKioAAAAASUVORK5CYII='),
		(c) => c.charCodeAt(0)
	)
	function providers() {
		const calls: string[] = []
		return {
			calls,
			bindings: testEnv({
				IMAGES: {
					info: async (stream) => {
						await new Response(stream).arrayBuffer()
						return { width: 1, height: 1, format: 'image/png' }
					},
					input: (stream) => ({
						transform: () => ({
							output: async () => {
								await new Response(stream).arrayBuffer()
								calls.push('image')
								return { response: () => new Response(png) }
							},
						}),
					}),
				},
				MEDIA: {
					input: (stream) => ({
						output: (options) => ({
							response: async () => {
								await new Response(stream).arrayBuffer()
								calls.push(options.mode)
								return new Response(options.mode === 'video' ? bytes('short.mp4') : png)
							},
						}),
					}),
				},
			}),
		}
	}
	async function upload(raw: string, file: Uint8Array, type: string, bindings = testEnv()) {
		const form = new FormData()
		form.set('file', new File([file], 'media', { type }))
		form.set('description', 'An accessible description')
		form.set('focus', '0.2,-0.3')
		return request(
			'/api/v2/media',
			{ method: 'POST', headers: { Authorization: `Bearer ${raw}` }, body: form },
			bindings
		)
	}
	it('uploads, processes and atomically attaches media once, including range delivery', async () => {
		const { raw } = await seed(),
			provider = providers()
		const uploaded = await upload(raw, png, 'image/png', provider.bindings)
		expect(uploaded.status).toBe(202)
		const attachment = await uploaded.json<{ id: string; url: null }>()
		expect(attachment.url).toBeNull()
		expect(
			(await request('/api/v1/media/' + attachment.id, { headers: { Authorization: `Bearer ${raw}` } })).status
		).toBe(206)
		await executeJob(provider.bindings, `media:${attachment.id}`)
		const ready = await request('/api/v1/media/' + attachment.id, { headers: { Authorization: `Bearer ${raw}` } })
		expect(ready.status).toBe(200)
		const result = await ready.json<{ url: string; description: string }>()
		expect(result.description).toBe('An accessible description')
		const range = await request(new URL(result.url).pathname, { headers: { Range: 'bytes=0-3' } })
		expect(range.status).toBe(206)
		expect(new Uint8Array(await range.arrayBuffer())).toEqual(png.slice(0, 4))
		const posts = await Promise.all([
			json('/api/v1/statuses', { media_ids: [attachment.id] }, raw),
			json('/api/v1/statuses', { media_ids: [attachment.id] }, raw),
		])
		expect(posts.map((p) => p.status).sort()).toEqual([200, 422])
		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM statuses').first<{ n: number }>()
		expect(count!.n).toBe(1)
		expect((await env.MEDIA_BUCKET.list({ prefix: 'original/' })).objects).toHaveLength(0)
	})
	it('parses real MP4 and MP3 files and rejects 60-second video before provider work', async () => {
		const { raw } = await seed(),
			provider = providers()
		for (const [file, type, expected] of [
			['short.mp4', 'video/mp4', 200],
			['short.mp3', 'audio/mpeg', 200],
			['sixty-seconds.mp4', 'video/mp4', 422],
		] as const) {
			const response = await upload(raw, bytes(file), type, provider.bindings)
			expect(response.status).toBe(202)
			const value = await response.json<{ id: string }>()
			await executeJob(provider.bindings, `media:${value.id}`)
			const polled = await request('/api/v1/media/' + value.id, { headers: { Authorization: `Bearer ${raw}` } })
			expect(polled.status, await polled.clone().text()).toBe(expected)
		}
		expect(provider.calls).toEqual(['video', 'frame'])
	})
	it('retries transient processing errors and cleans up abandoned objects', async () => {
		const { raw } = await seed(),
			provider = providers()
		const response = await upload(raw, png, 'image/png')
		const value = await response.json<{ id: string }>()
		await executeJob(
			testEnv({
				IMAGES: {
					info: async () => {
						throw new Error('provider unavailable')
					},
				} as unknown as Env['IMAGES'],
			}),
			`media:${value.id}`
		)
		expect(await env.DB.prepare('SELECT state,attempt FROM jobs WHERE id=?').bind(`media:${value.id}`).first()).toEqual(
			{ state: 'pending', attempt: 1 }
		)
		await env.DB.prepare('UPDATE jobs SET available_at=0 WHERE id=?').bind(`media:${value.id}`).run()
		await executeJob(provider.bindings, `media:${value.id}`)
		expect((await request('/api/v1/media/' + value.id, { headers: { Authorization: `Bearer ${raw}` } })).status).toBe(
			200
		)
		await env.DB.prepare('UPDATE media_attachments SET updated_at=0 WHERE id=?').bind(value.id).run()
		await sweep(testEnv())
		expect((await env.MEDIA_BUCKET.list()).objects).toHaveLength(0)
		expect((await request('/api/v1/media/' + value.id, { headers: { Authorization: `Bearer ${raw}` } })).status).toBe(
			404
		)
	})
	it('rejects oversized, unsupported, malformed and duplicate uploads without retaining objects', async () => {
		const { raw } = await seed()
		expect((await upload(raw, png, 'image/png', testEnv({ MAX_MEDIA_BYTES: '20' }))).status).toBe(413)
		expect((await upload(raw, png, 'text/html')).status).toBe(415)
		expect(
			(
				await request('/api/v2/media', {
					method: 'POST',
					headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'multipart/form-data;' },
					body: 'invalid',
				})
			).status
		).toBe(400)
		expect(
			(
				await request('/api/v2/media', {
					method: 'POST',
					headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'multipart/form-data; boundary=truncated' },
					body: '--truncated\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\npartial',
				})
			).status
		).toBe(400)
		const form = new FormData()
		form.append('file', new File([png], 'one', { type: 'image/png' }))
		form.append('file', new File([png], 'two', { type: 'image/png' }))
		expect(
			(await request('/api/v2/media', { method: 'POST', headers: { Authorization: `Bearer ${raw}` }, body: form }))
				.status
		).toBe(422)
		expect((await env.MEDIA_BUCKET.list()).objects).toHaveLength(0)
	})
})

describe('posting and durability', () => {
	it('acknowledges durable completion and retries when D1 cannot record a result', async () => {
		const { raw } = await seed()
		await json('/api/v1/statuses', { status: 'queue boundary' }, raw)
		const body = queued[0]!
		const success = createMessageBatch<JobMessage>('test', [
			{ id: 'delivery-1', attempts: 1, timestamp: new Date(), body },
		])
		await consume(success, testEnv())
		const completed = await getQueueResult(success, createExecutionContext())
		expect(completed.explicitAcks).toEqual(['delivery-1'])
		await env.DB.prepare('DROP TABLE jobs').run()
		const failure = createMessageBatch<JobMessage>('test', [
			{ id: 'delivery-2', attempts: 1, timestamp: new Date(), body },
		])
		await consume(failure, testEnv())
		const retry = await getQueueResult(failure, createExecutionContext())
		expect(retry.explicitAcks).toEqual([])
		expect(retry.retryMessages.map((message: { msgId: string }) => message.msgId)).toEqual(['delivery-2'])
	})
	it('posts once under concurrent retries, escapes HTML and rejects changed idempotency input', async () => {
		const { raw } = await seed()
		const responses = await Promise.all([
			json('/api/v1/statuses', { status: 'hello <script>alert(1)</script>' }, raw, { 'Idempotency-Key': 'same' }),
			json('/api/v1/statuses', { status: 'hello <script>alert(1)</script>' }, raw, { 'Idempotency-Key': 'same' }),
		])
		expect(responses.map((r) => r.status)).toEqual([200, 200])
		const values = await Promise.all(responses.map((r) => r.json<{ id: string; content: string }>()))
		expect(values[0]!.id).toBe(values[1]!.id)
		expect(BigInt(values[0]!.id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
		expect(values[0]!.content).toContain('&lt;script&gt;')
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>())!.n).toBe(1)
		expect((await json('/api/v1/statuses', { status: 'changed' }, raw, { 'Idempotency-Key': 'same' })).status).toBe(409)
	})
	it('enforces visibility, reply privacy, edits, deletion and pagination', async () => {
		const { raw } = await seed()
		const privatePost = await (
			await json('/api/v1/statuses', { status: 'private', visibility: 'private' }, raw)
		).json<{ id: string }>()
		expect((await request('/api/v1/statuses/' + privatePost.id)).status).toBe(404)
		expect(
			(await json('/api/v1/statuses', { status: 'public reply', in_reply_to_id: privatePost.id }, raw)).status
		).toBe(422)
		const publicPost = await (await json('/api/v1/statuses', { status: 'public' }, raw)).json<{ id: string }>()
		await json(
			'/api/v1/statuses',
			{ status: 'private reply', in_reply_to_id: publicPost.id, visibility: 'private' },
			raw
		)
		const context = await (
			await request(`/api/v1/statuses/${publicPost.id}/context`)
		).json<{ descendants: unknown[] }>()
		expect(context.descendants).toEqual([])
		const publicFeed = await request('/api/v1/timelines/public?limit=1')
		expect((await publicFeed.json<{ id: string }[]>()).map((s) => s.id)).toEqual([publicPost.id])
		expect(publicFeed.headers.get('Link')).toContain('max_id=')
		const edited = await request('/api/v1/statuses/' + publicPost.id, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'edited' }),
		})
		expect(edited.status).toBe(200)
		expect((await edited.json<{ content: string }>()).content).toBe('<p>edited</p>')
		const deleted = await request('/api/v1/statuses/' + publicPost.id, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${raw}` },
		})
		expect(deleted.status).toBe(200)
		expect((await request('/api/v1/statuses/' + publicPost.id)).status).toBe(404)
	})
	it('keeps committed work after queue failure and recovers a crashed consumer lease', async () => {
		const { raw } = await seed()
		const failing = testEnv({
			JOBS: {
				send: async () => {
					throw new Error('queue unavailable')
				},
			} as unknown as Env['JOBS'],
		})
		const response = await request(
			'/api/v1/statuses',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'survives' }),
			},
			failing
		)
		expect(response.status).toBe(200)
		const job = await env.DB.prepare('SELECT id,state FROM jobs').first<{ id: string; state: string }>()
		expect(job!.state).toBe('pending')
		await publishDue(testEnv())
		expect(queued).toEqual([{ version: 1, id: job!.id }])
		await env.DB.prepare("UPDATE jobs SET state='processing',lease_until=?,lease_token='crashed' WHERE id=?")
			.bind(Date.now() - 1, job!.id)
			.run()
		await executeJob(testEnv(), job!.id)
		await executeJob(testEnv(), job!.id)
		expect(await env.DB.prepare('SELECT state,attempt FROM jobs WHERE id=?').bind(job!.id).first()).toEqual({
			state: 'done',
			attempt: 1,
		})
	})
	it('keeps hibernating streaming subscriptions and closes a revoked token', async () => {
		const { id, raw } = await seed()
		const response = await request('/api/v1/streaming?stream=user&access_token=' + raw, {
			headers: { Upgrade: 'websocket' },
		})
		expect(response.status).toBe(101)
		const socket = response.webSocket!
		socket.accept()
		const stub = env.STREAMS.get(env.STREAMS.idFromName(id))
		await evictDurableObject(stub)
		const event = new Promise<MessageEvent>((resolve) => socket.addEventListener('message', resolve, { once: true }))
		await json('/api/v1/statuses', { status: 'after hibernation' }, raw)
		await executeJob(testEnv(), queued[0]!.id)
		const message = JSON.parse((await event).data as string) as { event: string; payload: string }
		expect(message.event).toBe('update')
		expect(JSON.parse(message.payload).content).toBe('<p>after hibernation</p>')
		const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', resolve, { once: true }))
		await json('/oauth/revoke', { client_id: 'client', client_secret: 'secret', token: raw })
		expect((await closed).code).toBe(1008)
	})
})
