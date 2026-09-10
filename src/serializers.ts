import type { AccountRow, Env, MediaRow, StatusRow } from './types'

export async function accountJSON(env: Env, account: AccountRow, source = false) {
	const stats = await env.DB.prepare(
		'SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM statuses WHERE account_id = ? AND deleted_at IS NULL'
	)
		.bind(account.id)
		.first<{ count: number; latest: string | null }>()
	const avatar = env.PUBLIC_ORIGIN + '/avatar.svg'
	return {
		id: account.id,
		username: account.username,
		acct: account.username,
		display_name: account.display_name,
		locked: true,
		bot: false,
		discoverable: false,
		indexable: false,
		group: false,
		created_at: account.created_at,
		note: account.note,
		url: `${env.PUBLIC_ORIGIN}/@${account.username}`,
		uri: `${env.PUBLIC_ORIGIN}/users/${account.username}`,
		avatar,
		avatar_static: avatar,
		header: avatar,
		header_static: avatar,
		followers_count: 0,
		following_count: 0,
		statuses_count: stats?.count ?? 0,
		last_status_at: stats?.latest?.slice(0, 10) ?? null,
		emojis: [],
		fields: [],
		...(source
			? {
					source: {
						privacy: 'public',
						sensitive: false,
						language: null,
						note: account.note,
						fields: [],
						follow_requests_count: 0,
					},
				}
			: {}),
	}
}

export function mediaJSON(env: Env, media: MediaRow) {
	const url = (key: string | null) => (key ? `${env.PUBLIC_ORIGIN}/media/${key.replace(/^public\//, '')}` : null)
	return {
		id: media.id,
		type: media.media_type,
		url: media.state === 'ready' ? url(media.output_key) : null,
		preview_url: media.state === 'ready' ? url(media.preview_key) : null,
		remote_url: null,
		preview_remote_url: null,
		text_url: null,
		description: media.description,
		blurhash: null,
		meta: { ...JSON.parse(media.metadata), focus: { x: media.focus_x, y: media.focus_y } },
	}
}

export function visible(status: StatusRow, viewer: string | null): boolean {
	return (
		!status.deleted_at &&
		(status.visibility === 'public' || status.visibility === 'unlisted' || status.account_id === viewer)
	)
}

export async function statusJSON(env: Env, status: StatusRow, viewer: string | null) {
	const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
		.bind(status.account_id)
		.first<AccountRow>()
	if (!account) throw new Error('Status author is missing')
	const media = await env.DB.prepare('SELECT * FROM media_attachments WHERE status_id = ? ORDER BY position')
		.bind(status.id)
		.all<MediaRow>()
	const replies = await env.DB.prepare(
		`SELECT COUNT(*) AS count FROM statuses WHERE in_reply_to_id = ? AND deleted_at IS NULL AND (visibility IN ('public','unlisted') OR account_id = ?)`
	)
		.bind(status.id, viewer)
		.first<{ count: number }>()
	const uri = `${env.PUBLIC_ORIGIN}/users/${account.username}/statuses/${status.id}`
	return {
		id: status.id,
		created_at: status.created_at,
		edited_at: status.edited_at,
		in_reply_to_id: status.in_reply_to_id,
		in_reply_to_account_id: status.in_reply_to_id ? status.account_id : null,
		sensitive: Boolean(status.sensitive),
		spoiler_text: status.spoiler_text,
		visibility: status.visibility,
		language: status.language,
		uri,
		url: `${env.PUBLIC_ORIGIN}/@${account.username}/${status.id}`,
		content: status.content,
		account: await accountJSON(env, account),
		replies_count: replies?.count ?? 0,
		reblogs_count: 0,
		favourites_count: 0,
		reblog: null,
		application: null,
		media_attachments: media.results.map((m) => mediaJSON(env, m)),
		mentions: [],
		tags: [],
		emojis: [],
		card: null,
		poll: null,
		quote: null,
		filtered: [],
		favourited: false,
		reblogged: false,
		muted: false,
		bookmarked: false,
		pinned: false,
		...(viewer === status.account_id ? { text: status.text } : {}),
	}
}
