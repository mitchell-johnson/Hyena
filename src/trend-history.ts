import { all, type Bind } from './data'
import { audienceSQL } from './policy'
import { limitedAccountSQL } from './moderation-policy'
import type { Env } from './types'

export async function trendHistory(env: Env, viewer: string | null, predicate: string, binds: Bind[]) {
	const today = Math.floor(Date.now() / 86400000),
		policy = audienceSQL(viewer, 's')
	const rows = await all<{ day: string; uses: number; accounts: number }>(
		env,
		`SELECT strftime('%s',date(s.created_at)) day,COUNT(*) uses,COUNT(DISTINCT s.account_id) accounts FROM statuses s JOIN accounts a ON a.id=s.account_id WHERE s.visibility='public' AND s.reblog_of_id IS NULL AND s.created_at>=? AND s.created_at<? AND ${policy.sql} AND NOT ${limitedAccountSQL()} AND (${predicate}) GROUP BY date(s.created_at)`,
		new Date((today - 6) * 86400000).toISOString(),
		new Date((today + 1) * 86400000).toISOString(),
		...policy.binds,
		...binds
	)
	return Array.from({ length: 7 }, (_, d) => {
		const day = String((today - d) * 86400),
			row = rows.find((r) => r.day === day)
		return { day, uses: String(row?.uses ?? 0), accounts: String(row?.accounts ?? 0) }
	})
}
