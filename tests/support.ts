import { env as runtimeEnv } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import type { D1Migration } from '@cloudflare/vitest-plugin'
import worker from '../src/index'
import { digest, randomToken, passwordHash } from '../src/auth/crypto'
import { nextId } from '../src/db'
import type { Env } from '../src/types'
export const runtime = runtimeEnv as unknown as Env & {
	TEST_MIGRATIONS: D1Migration[]
	TEST_FILES: Record<string, string>
}
export const env: Env = { ...runtime, JOBS: { send: async () => {} } as unknown as Env['JOBS'] }
export async function request(
	path: string,
	{
		token,
		method = 'GET',
		body,
		cookie,
		headers = {},
		bindings = env,
	}: {
		token?: string
		method?: string
		body?: unknown
		cookie?: string
		headers?: Record<string, string>
		bindings?: Env
	} = {}
) {
	const ctx = createExecutionContext(),
		res = await worker.fetch(
			new Request(env.PUBLIC_ORIGIN + path, {
				method,
				headers: {
					...(token ? { Authorization: 'Bearer ' + token } : {}),
					...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
					...(cookie ? { Cookie: cookie } : {}),
					...headers,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			bindings,
			ctx
		)
	await waitOnExecutionContext(ctx)
	return res
}
export async function json<T = Record<string, unknown>>(
	path: string,
	options: Parameters<typeof request>[1] = {}
): Promise<T> {
	const res = await request(path, options),
		body = await res.json<T>()
	if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`)
	return body
}
export async function seed(username: string, role = 'user') {
	const id = await nextId(env.DB),
		app = await nextId(env.DB),
		token = randomToken(),
		cookie = randomToken(),
		csrf = randomToken(),
		password = 'a-long-test-password-42',
		scopes = 'read write profile push admin:read admin:write'
	await env.DB.batch([
		env.DB.prepare(
			'INSERT INTO accounts(id,username,password_hash,created_at,role,discoverable,indexable,locked) VALUES(?,?,?,?,?,1,1,0)'
		).bind(id, username, passwordHash(password), new Date().toISOString(), role),
		env.DB.prepare(
			'INSERT INTO oauth_apps(id,name,client_id,secret_hash,redirect_uris,scopes,created_at) VALUES(?,?,?,?,?,?,?)'
		).bind(
			app,
			username,
			app,
			await digest('app-secret'),
			'["hyena-test://callback"]',
			scopes,
			new Date().toISOString()
		),
		env.DB.prepare('INSERT INTO oauth_tokens(token_hash,app_id,account_id,scopes,created_at) VALUES(?,?,?,?,?)').bind(
			await digest(token),
			app,
			id,
			scopes,
			Date.now()
		),
		env.DB.prepare('INSERT INTO sessions(token_hash,account_id,csrf,expires_at) VALUES(?,?,?,?)').bind(
			await digest(cookie),
			id,
			csrf,
			Date.now() + 3600000
		),
	])
	return {
		id,
		app,
		token,
		cookie: 'hyena_session=' + cookie,
		cookieRaw: cookie,
		csrf,
		password,
		headers: { Origin: env.PUBLIC_ORIGIN, 'X-CSRF-Token': csrf },
	}
}
