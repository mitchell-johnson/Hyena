import { one, setting } from './data'
import { ApiError } from './http'
import type { Env } from './types'
export async function charge(
	env: Env,
	id: string,
	kind: 'media_bytes' | 'image_transforms' | 'media_seconds',
	amount: number
) {
	const period = new Date().toISOString().slice(0, 7),
		limit = await setting<number>(env, 'monthly_' + kind, kind === 'media_bytes' ? 1073741824 : 5000)
	if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(limit) || limit < 0)
		throw new ApiError(503, 'Invalid media budget')
	if (await one(env, 'SELECT 1 FROM usage_charges WHERE id=?', id)) return
	const results = await env.DB.batch([
		env.DB.prepare('INSERT OR IGNORE INTO usage_counters VALUES(?,?,0)').bind(period, kind),
		env.DB.prepare(
			'INSERT OR IGNORE INTO usage_charges(id,period,kind,amount) SELECT ?,?,?,? WHERE (SELECT total FROM usage_counters WHERE period=? AND kind=?)+?<=?'
		).bind(id, period, kind, amount, period, kind, amount, limit),
		env.DB.prepare('UPDATE usage_counters SET total=total+? WHERE period=? AND kind=? AND changes()=1').bind(
			amount,
			period,
			kind
		),
	])
	if (!results[1]?.meta.changes && !(await one(env, 'SELECT 1 FROM usage_charges WHERE id=?', id)))
		throw new ApiError(429, 'The instance monthly media budget has been reached')
}
