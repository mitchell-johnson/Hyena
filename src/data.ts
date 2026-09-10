import type { Context } from 'hono'
import type { AccountRow, AppEnv, Env, StatusRow } from './types'
import { ApiError } from './http'
import { isId } from './db'

export type Bind = string | number | null
export const now = () => new Date().toISOString()
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'Expected an object')
	return value as Record<string, unknown>
}
export function list(value: unknown, max = 100): string[] {
	if (value === undefined) return []
	if (!Array.isArray(value) || value.length > max || value.some((x) => typeof x !== 'string'))
		throw new ApiError(422, 'Expected a bounded string array')
	return [...new Set(value as string[])]
}
export const parsed = <T>(text: string | null | undefined, fallback: T): T =>
	text ? (JSON.parse(text) as T) : fallback
export const all = async <T>(env: Env, sql: string, ...bind: Bind[]) =>
	(
		await env.DB.prepare(sql)
			.bind(...bind)
			.all<T>()
	).results
export const one = <T>(env: Env, sql: string, ...bind: Bind[]) =>
	env.DB.prepare(sql)
		.bind(...bind)
		.first<T>()
export const run = (env: Env, sql: string, ...bind: Bind[]) =>
	env.DB.prepare(sql)
		.bind(...bind)
		.run()
export async function accountById(env: Env, id: string) {
	const account = await one<AccountRow>(env, 'SELECT * FROM accounts WHERE id=?', id)
	if (!account) throw new ApiError(404, 'Record not found')
	return account
}
export function accountUri(env: Env, a: AccountRow) {
	return a.uri || `${env.PUBLIC_ORIGIN}/users/${a.username}`
}
export function statusUri(env: Env, s: StatusRow, a: AccountRow) {
	return s.uri || `${accountUri(env, a)}/statuses/${s.id}`
}
export function pageLimit(c: Context<AppEnv>, maximum = 80, fallback = 20) {
	const raw = c.req.query('limit') ?? String(fallback)
	if (!/^\d+$/.test(raw)) throw new ApiError(400, 'Invalid limit')
	return Math.max(1, Math.min(maximum, Number(raw)))
}
export function cursors(c: Context<AppEnv>, column = 'id') {
	const clauses: string[] = [],
		binds: Bind[] = []
	for (const [key, op] of [
		['max_id', '<'],
		['since_id', '>'],
		['min_id', '>'],
	] as const) {
		const id = c.req.query(key)
		if (!id) continue
		if (!isId(id)) throw new ApiError(400, `Invalid ${key}`)
		clauses.push(`CAST(${column} AS INTEGER) ${op} CAST(? AS INTEGER)`)
		binds.push(id)
	}
	return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', binds, ascending: !!c.req.query('min_id') }
}
export function links(c: Context<AppEnv>, rows: { id: string }[]) {
	if (!rows.length) return
	const next = new URL(c.req.url),
		prev = new URL(c.req.url)
	for (const key of ['min_id', 'max_id', 'since_id']) {
		next.searchParams.delete(key)
		prev.searchParams.delete(key)
	}
	next.searchParams.set('max_id', rows.at(-1)!.id)
	prev.searchParams.set('min_id', rows[0]!.id)
	c.header('Link', `<${next}>; rel="next", <${prev}>; rel="prev"`)
}
export async function setting<T>(env: Env, key: string, fallback: T): Promise<T> {
	return parsed((await one<{ value: string }>(env, 'SELECT value FROM settings WHERE key=?', key))?.value, fallback)
}
