import type { AccountRow, Env, MediaRow, StatusRow } from './types'
import { accountById, accountUri, all, one, parsed, statusUri } from './data'
import { audienceSQL, visible } from './policy'
export { visible } from './policy'
import { domainPolicy } from './moderation-policy'

export interface AccountEntity {
	id: string
	username: string
	acct: string
	display_name: string
	url: string
	uri: string
	avatar: string
	header: string
	note: string
	[key: string]: unknown
}
export async function accountJSON(env: Env, a: AccountRow, source = false, depth = 0): Promise<AccountEntity> {
	const stats = await one<{ count: number; latest: string | null }>(
		env,
		'SELECT COUNT(*) count,MAX(created_at) latest FROM statuses WHERE account_id=? AND deleted_at IS NULL',
		a.id
	)
	const counts = await one<{ followers: number; following: number; requests: number }>(
		env,
		`SELECT (SELECT COUNT(*) FROM follows WHERE following_id=? AND state='accepted') followers,(SELECT COUNT(*) FROM follows WHERE follower_id=? AND state='accepted') following,(SELECT COUNT(*) FROM follows WHERE following_id=? AND state='pending') requests`,
		a.id,
		a.id,
		a.id
	)
	const prefs = parsed<Record<string, unknown>>(a.preferences, {}),
		fields = parsed<{ name: string; value: string; verified_at?: string | null }[]>(a.fields, [])
	const moderation = a.domain ? await domainPolicy(env, a.domain) : null
	const avatar = (moderation?.rejectMedia ? null : a.avatar) || env.PUBLIC_ORIGIN + '/avatar.svg',
		header = (moderation?.rejectMedia ? null : a.header) || env.PUBLIC_ORIGIN + '/avatar.svg'
	return {
		id: a.id,
		username: a.username,
		acct: a.username + (a.domain ? '@' + a.domain : ''),
		display_name: a.display_name,
		locked: !!a.locked,
		bot: !!a.bot,
		discoverable: !!a.discoverable,
		indexable: !!a.indexable,
		group: false,
		created_at: a.created_at,
		note: a.note,
		url: a.url || `${env.PUBLIC_ORIGIN}/@${a.username}`,
		uri: accountUri(env, a),
		avatar,
		avatar_static: avatar,
		header,
		header_static: header,
		followers_count: counts?.followers ?? 0,
		following_count: counts?.following ?? 0,
		statuses_count: stats?.count ?? 0,
		last_status_at: stats?.latest?.slice(0, 10) ?? null,
		emojis: await emojiJSON(env, a.note + ' ' + a.display_name),
		fields: fields.map((f) => ({ ...f, verified_at: f.verified_at ?? null })),
		noindex: !a.indexable,
		hide_collections: !!prefs.hide_collections,
		suspended: !!a.suspended || !!moderation?.suspended,
		limited: !!a.silenced || !!moderation?.limited,
		roles:
			a.role === 'admin'
				? [{ id: '1', name: 'Admin', color: '#27845b' }]
				: a.role === 'moderator'
					? [{ id: '2', name: 'Moderator', color: '#27845b' }]
					: [],
		moved:
			a.moved_to_id && depth < 1
				? await accountJSON(env, await accountById(env, a.moved_to_id), false, depth + 1)
				: null,
		...(source
			? {
					source: {
						privacy: prefs['posting:default:visibility'] ?? 'public',
						sensitive: prefs['posting:default:sensitive'] ?? false,
						language: prefs['posting:default:language'] ?? null,
						note: prefs.note_raw ?? a.note,
						fields,
						follow_requests_count: counts?.requests ?? 0,
					},
					role: {
						id: a.role === 'admin' ? '1' : '0',
						name: a.role === 'admin' ? 'Owner' : 'User',
						color: '',
						position: a.role === 'admin' ? 100 : 0,
						permissions: a.role === 'admin' ? '1' : '0',
						highlighted: false,
					},
				}
			: {}),
	}
}
export async function emojiJSON(env: Env, text?: string) {
	const rows = await all<{
		shortcode: string
		url: string
		static_url: string
		category: string | null
		visible: number
	}>(env, 'SELECT * FROM custom_emojis ORDER BY shortcode')
	return rows
		.filter((e) => text === undefined || text.includes(':' + e.shortcode + ':'))
		.map((e) => ({
			shortcode: e.shortcode,
			url: e.url,
			static_url: e.static_url,
			visible_in_picker: !!e.visible,
			category: e.category ?? undefined,
		}))
}
export function mediaJSON(env: Env, m: MediaRow) {
	const url = (key: string | null) => (key ? `${env.PUBLIC_ORIGIN}/media/${key.replace(/^public\//, '')}` : null)
	return {
		id: m.id,
		type: m.media_type,
		url: m.state === 'ready' ? m.remote_url || url(m.output_key) : null,
		preview_url: m.state === 'ready' ? m.preview_remote_url || url(m.preview_key) : null,
		remote_url: m.remote_url ?? null,
		preview_remote_url: m.preview_remote_url ?? null,
		text_url: null,
		description: m.description,
		blurhash: parsed<Record<string, unknown>>(m.metadata, {}).blurhash ?? null,
		meta: { ...parsed(m.metadata, {}), focus: { x: m.focus_x, y: m.focus_y } },
	}
}
export async function pollJSON(env: Env, statusId: string, viewer: string | null) {
	const p = await one<{
		id: string
		multiple: number
		hide_totals: number
		expires_at: string
		options: string
		remote_votes: string
	}>(env, 'SELECT * FROM polls WHERE status_id=?', statusId)
	if (!p) return null
	const options = parsed<string[]>(p.options, []),
		remote = parsed<number[]>(p.remote_votes, []),
		votes = await all<{ choice: number; n: number }>(
			env,
			'SELECT choice,COUNT(*) n FROM poll_votes WHERE poll_id=? GROUP BY choice',
			p.id
		)
	const own = viewer
		? await all<{ choice: number }>(
				env,
				'SELECT choice FROM poll_votes WHERE poll_id=? AND account_id=? ORDER BY choice',
				p.id,
				viewer
			)
		: []
	const expired = Date.parse(p.expires_at) <= Date.now(),
		counts = options.map((_, i) => (remote.length ? (remote[i] ?? 0) : (votes.find((v) => v.choice === i)?.n ?? 0))),
		hide = p.hide_totals && !expired && !own.length
	const voters = await one<{ n: number }>(
		env,
		'SELECT COUNT(DISTINCT account_id) n FROM poll_votes WHERE poll_id=?',
		p.id
	)
	return {
		id: p.id,
		expires_at: p.expires_at,
		expired,
		multiple: !!p.multiple,
		votes_count: hide ? 0 : counts.reduce((a, b) => a + b, 0),
		voters_count: hide || remote.length ? null : (voters?.n ?? 0),
		voted: !!own.length,
		own_votes: own.map((v) => v.choice),
		options: options.map((title, i) => ({ title, votes_count: hide ? null : counts[i] })),
		emojis: await emojiJSON(env, options.join(' ')),
	}
}
export async function filterJSON(env: Env, id: string) {
	const f = await one<{ id: string; title: string; context: string; expires_at: string | null; filter_action: string }>(
		env,
		'SELECT * FROM filters WHERE id=?',
		id
	)
	if (!f) return null
	return {
		...f,
		context: parsed<string[]>(f.context, []),
		keywords: (
			await all<{ id: string; keyword: string; whole_word: number }>(
				env,
				'SELECT * FROM filter_keywords WHERE filter_id=?',
				id
			)
		).map((k) => ({ id: k.id, keyword: k.keyword, whole_word: !!k.whole_word })),
		statuses: await all<{ id: string; status_id: string }>(
			env,
			'SELECT id,status_id FROM filter_statuses WHERE filter_id=?',
			id
		),
	}
}
export async function matchesFilters(env: Env, status: StatusRow, viewer: string | null, context = 'home') {
	if (!viewer) return []
	const filters = await all<{ id: string }>(
		env,
		'SELECT id FROM filters WHERE account_id=? AND (expires_at IS NULL OR expires_at>?)',
		viewer,
		new Date().toISOString()
	)
	const result = []
	for (const row of filters) {
		const f = (await filterJSON(env, row.id))!
		if (!f.context.includes(context)) continue
		const text = (status.text + ' ' + status.spoiler_text).toLocaleLowerCase()
		const keywords = f.keywords.filter((k) => {
			const term = k.keyword.toLocaleLowerCase()
			if (!k.whole_word) return text.includes(term)
			const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(text)
		})
		const statuses = f.statuses.filter((s) => s.status_id === status.id)
		if (keywords.length || statuses.length)
			result.push({
				filter: f,
				keyword_matches: keywords.map((k) => k.keyword),
				status_matches: statuses.map((s) => s.status_id),
			})
	}
	return result
}
export type StatusEntity = { id: string; account: Awaited<ReturnType<typeof accountJSON>>; [key: string]: unknown }
export async function statusJSON(
	env: Env,
	s: StatusRow,
	viewer: string | null,
	depth = 0,
	context = 'home'
): Promise<StatusEntity> {
	const a = await accountById(env, s.account_id),
		media =
			a.domain && (await domainPolicy(env, a.domain)).rejectMedia
				? []
				: await all<MediaRow>(env, 'SELECT * FROM media_attachments WHERE status_id=? ORDER BY position', s.id)
	const p = audienceSQL(viewer),
		replies = await one<{ count: number }>(
			env,
			`SELECT COUNT(*) count FROM statuses WHERE in_reply_to_id=? AND ${p.sql}`,
			s.id,
			...p.binds
		)
	const ints = await all<{ kind: string; account_id: string }>(
		env,
		'SELECT kind,account_id FROM interactions WHERE status_id=?',
		s.id
	)
	const boosts = await one<{ n: number; mine: number }>(
		env,
		'SELECT COUNT(*) n,MAX(account_id=?) mine FROM statuses WHERE reblog_of_id=? AND deleted_at IS NULL',
		viewer,
		s.id
	)
	const reply = s.in_reply_to_id
		? await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', s.in_reply_to_id)
		: null
	const mentions = await all<AccountRow>(
		env,
		'SELECT a.* FROM accounts a JOIN status_recipients r ON r.account_id=a.id WHERE r.status_id=? AND r.mentioned=1',
		s.id
	)
	const tags = await all<{ name: string; display_name: string }>(
		env,
		'SELECT t.* FROM tags t JOIN status_tags st ON st.tag=t.name WHERE st.status_id=?',
		s.id
	)
	const nested = async (id: string | null | undefined) => {
		if (!id || depth >= 2) return null
		const row = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', id)
		return row && (await visible(env, row, viewer)) ? statusJSON(env, row, viewer, depth + 1, context) : null
	}
	const app = s.application_id
		? await one<{ name: string; website: string | null }>(
				env,
				'SELECT name,website FROM oauth_apps WHERE id=?',
				s.application_id
			)
		: null
	const parentVisible = reply && (await visible(env, reply, viewer)),
		quoted = s.quote_id ? await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', s.quote_id) : null,
		quoteVisible = quoted && (await visible(env, quoted, viewer)),
		follows = viewer
			? await one(
					env,
					"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
					viewer,
					s.account_id
				)
			: null
	return {
		id: s.id,
		created_at: s.created_at,
		edited_at: s.edited_at,
		in_reply_to_id: parentVisible ? reply.id : null,
		in_reply_to_account_id: parentVisible ? reply.account_id : null,
		sensitive: !!s.sensitive,
		spoiler_text: s.spoiler_text,
		visibility: s.visibility,
		language: s.language,
		uri: statusUri(env, s, a),
		url: s.url || `${env.PUBLIC_ORIGIN}/@${a.username}/${s.id}`,
		content: s.content,
		account: await accountJSON(env, a),
		replies_count: replies?.count ?? 0,
		reblogs_count: boosts?.n ?? 0,
		favourites_count: ints.filter((i) => i.kind === 'favourite').length,
		reblog: await nested(s.reblog_of_id),
		application: app,
		media_attachments: media.map((m) => mediaJSON(env, m)),
		mentions: mentions.map((a) => ({
			id: a.id,
			username: a.username,
			acct: a.username + (a.domain ? '@' + a.domain : ''),
			url: a.url || `${env.PUBLIC_ORIGIN}/@${a.username}`,
		})),
		tags: tags.map((t) => ({ name: t.display_name, url: `${env.PUBLIC_ORIGIN}/tags/${encodeURIComponent(t.name)}` })),
		emojis: await emojiJSON(env, s.text),
		card: parsed(s.card, null),
		poll: await pollJSON(env, s.id, viewer),
		quote: s.quote_id
			? {
					state:
						!quoted || quoted.deleted_at ? 'deleted' : !quoteVisible ? 'unauthorized' : (s.quote_state ?? 'pending'),
					quoted_status: s.quote_state === 'accepted' ? await nested(s.quote_id) : null,
				}
			: null,
		quote_approval: {
			automatic: s.quote_policy === 'public' ? ['public'] : s.quote_policy === 'followers' ? ['followers'] : [],
			manual: [],
			current_user:
				viewer === s.account_id ||
				(['public', 'unlisted'].includes(s.visibility) &&
					(s.quote_policy === 'public' || (s.quote_policy === 'followers' && follows)))
					? 'automatic'
					: 'denied',
		},
		filtered: await matchesFilters(env, s, viewer, context),
		favourited: ints.some((i) => i.kind === 'favourite' && i.account_id === viewer),
		reblogged: !!boosts?.mine,
		muted: ints.some((i) => i.kind === 'mute' && i.account_id === viewer),
		bookmarked: ints.some((i) => i.kind === 'bookmark' && i.account_id === viewer),
		pinned: ints.some((i) => i.kind === 'pin' && i.account_id === viewer),
		...(viewer === s.account_id ? { text: s.text } : {}),
	}
}
