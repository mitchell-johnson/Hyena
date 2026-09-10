import type { Context } from 'hono'
import { Hono } from 'hono'
import { authenticate, optionalAccount } from './auth/access'
import { all, one, cursors, links, pageLimit, type Bind } from './data'
import { audienceSQL, mutedSQL } from './policy'
import { statusJSON } from './serializers'
import { ApiError } from './http'
import { limitedAccountSQL } from './moderation-policy'
import type { AppEnv, StatusRow } from './types'

export const timelines = new Hono<AppEnv>()
export type TimelineMode = 'public' | 'home' | 'account' | 'tag' | 'list' | 'link'
export async function timeline(c: Context<AppEnv>, mode: TimelineMode, id?: string) {
	const viewer = ['home', 'list'].includes(mode)
			? (await authenticate(c, 'read:statuses')).account_id
			: await optionalAccount(c),
		p = audienceSQL(viewer),
		m = mutedSQL(viewer),
		clauses = [p.sql, m.sql],
		binds: Bind[] = [...p.binds, ...m.binds]
	if (['public', 'tag', 'link'].includes(mode))
		clauses.push(`NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=statuses.account_id AND ${limitedAccountSQL()})`)
	if (mode === 'public') {
		clauses.push(
			"visibility='public'",
			'NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=statuses.account_id AND a.silenced=1)'
		)
	}
	if (mode === 'home') {
		clauses.push(
			`(account_id=? OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=statuses.account_id AND f.state='accepted' AND (statuses.reblog_of_id IS NULL OR f.reblogs=1) AND (f.languages='[]' OR statuses.language IS NULL OR EXISTS(SELECT 1 FROM json_each(f.languages) WHERE value=statuses.language))) OR (visibility='public' AND EXISTS(SELECT 1 FROM status_tags t JOIN account_tags f ON f.tag=t.tag WHERE t.status_id=statuses.id AND f.account_id=? AND f.kind='follow')))`
		)
		binds.push(viewer, viewer, viewer)
		clauses.push(
			`NOT EXISTS(SELECT 1 FROM lists l JOIN list_accounts m ON m.list_id=l.id WHERE l.account_id=? AND l.exclusive=1 AND m.account_id=statuses.account_id)`
		)
		binds.push(viewer)
	}
	if (mode === 'account') {
		clauses.push('account_id=?')
		binds.push(id ?? '')
		if (c.req.query('pinned') === 'true') {
			clauses.push(
				"EXISTS(SELECT 1 FROM interactions i WHERE i.status_id=statuses.id AND i.account_id=statuses.account_id AND i.kind='pin')"
			)
		}
	}
	if (mode === 'tag') {
		clauses.push("visibility='public'", 'EXISTS(SELECT 1 FROM status_tags WHERE status_id=statuses.id AND tag=?)')
		binds.push((id ?? '').toLocaleLowerCase())
		for (const [key, op] of [
			['any', 'any'],
			['all', 'all'],
			['none', 'none'],
		] as const) {
			const values = c.req.queries(key + '[]') ?? []
			if (values.length > 20) throw new ApiError(422, 'Too many tags')
			if (op === 'any' && values.length) {
				clauses.push(
					`EXISTS(SELECT 1 FROM status_tags WHERE status_id=statuses.id AND tag IN (${values.map(() => '?').join(',')}))`
				)
				binds.push(...values.map((v) => v.toLocaleLowerCase()))
			} else
				for (const value of values) {
					clauses.push(
						`${op === 'none' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM status_tags WHERE status_id=statuses.id AND tag=?)`
					)
					binds.push(value.toLocaleLowerCase())
				}
		}
	}
	if (mode === 'list') {
		const l = await one<{ id: string; replies_policy: string }>(
			c.env,
			'SELECT * FROM lists WHERE id=? AND account_id=?',
			id ?? '',
			viewer
		)
		if (!l) throw new ApiError(404, 'Record not found')
		clauses.push('EXISTS(SELECT 1 FROM list_accounts WHERE list_id=? AND account_id=statuses.account_id)')
		binds.push(l.id)
		if (l.replies_policy === 'none') clauses.push('in_reply_to_id IS NULL')
		else if (l.replies_policy === 'list') {
			clauses.push(
				'(in_reply_to_id IS NULL OR EXISTS(SELECT 1 FROM statuses parent JOIN list_accounts m ON m.account_id=parent.account_id WHERE parent.id=statuses.in_reply_to_id AND m.list_id=?))'
			)
			binds.push(l.id)
		} else {
			clauses.push(
				"(in_reply_to_id IS NULL OR EXISTS(SELECT 1 FROM statuses parent JOIN follows f ON f.following_id=parent.account_id WHERE parent.id=statuses.in_reply_to_id AND f.follower_id=? AND f.state='accepted'))"
			)
			binds.push(viewer)
		}
	}
	if (mode === 'link') {
		const url = c.req.query('url') ?? ''
		if (!/^https?:\/\//.test(url) || url.length > 2048) throw new ApiError(422, 'Invalid link')
		clauses.push("visibility='public'", "(json_extract(card,'$.url')=? OR instr(text,?)>0)")
		binds.push(url, url)
	}
	if (c.req.query('local') === 'true') clauses.push('local=1')
	if (c.req.query('remote') === 'true') clauses.push('local=0')
	if (['true', '1'].includes(c.req.query('only_media') ?? ''))
		clauses.push('EXISTS(SELECT 1 FROM media_attachments WHERE status_id=statuses.id)')
	if (c.req.query('exclude_replies') === 'true') clauses.push('in_reply_to_id IS NULL')
	if (c.req.query('exclude_reblogs') === 'true') clauses.push('reblog_of_id IS NULL')
	if (c.req.query('tagged')) {
		clauses.push('EXISTS(SELECT 1 FROM status_tags WHERE status_id=statuses.id AND tag=?)')
		binds.push(c.req.query('tagged')!.toLocaleLowerCase())
	}
	const cursor = cursors(c, 'sequence'),
		rows = await all<StatusRow>(
			c.env,
			`SELECT * FROM statuses WHERE ${clauses.join(' AND ')} ${cursor.sql} ORDER BY sequence ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
			...binds,
			...cursor.binds,
			pageLimit(c, 40)
		)
	if (cursor.ascending) rows.reverse()
	links(c, rows)
	const entities = await Promise.all(
		rows.map((s) =>
			statusJSON(
				c.env,
				s,
				viewer,
				0,
				mode === 'home' || mode === 'list' ? 'home' : mode === 'account' ? 'account' : 'public'
			)
		)
	)
	return c.json(entities)
}
timelines.get('/api/v1/timelines/home', (c) => timeline(c, 'home'))
timelines.get('/api/v1/timelines/public', (c) => timeline(c, 'public'))
timelines.get('/api/v1/timelines/tag/:id', (c) => timeline(c, 'tag', c.req.param('id')))
timelines.get('/api/v1/timelines/list/:id', (c) => timeline(c, 'list', c.req.param('id')))
timelines.get('/api/v1/timelines/link', (c) => timeline(c, 'link'))
timelines.get('/api/v1/accounts/:id/statuses', (c) => timeline(c, 'account', c.req.param('id')))
