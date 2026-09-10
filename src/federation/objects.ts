import type { AccountRow, Env, MediaRow, StatusRow } from '../types'
import { accountById, accountUri, statusUri, all, one, parsed } from '../data'
import { mediaJSON, pollJSON } from '../serializers'
import { QUOTE_CONTEXT } from './consent'
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
export async function activityObject(env: Env, s: StatusRow): Promise<Record<string, unknown>> {
	const a = await accountById(env, s.account_id),
		uri = statusUri(env, s, a),
		mentions = await all<AccountRow>(
			env,
			'SELECT a.* FROM accounts a JOIN status_recipients r ON r.account_id=a.id WHERE r.status_id=?',
			s.id
		),
		follower = accountUri(env, a) + '/followers',
		recipients = mentions.map((a) => accountUri(env, a))
	const tags = await all<{ tag: string }>(env, 'SELECT tag FROM status_tags WHERE status_id=?', s.id),
		media = await all<MediaRow>(env, 'SELECT * FROM media_attachments WHERE status_id=? ORDER BY position', s.id),
		poll = await pollJSON(env, s.id, a.id)
	const parent = s.in_reply_to_id
			? await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', s.in_reply_to_id)
			: null,
		quote =
			s.quote_id && ['accepted', 'pending'].includes(s.quote_state ?? '')
				? await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', s.quote_id)
				: null
	return {
		'@context': [
			...QUOTE_CONTEXT,
			{
				sensitive: 'as:sensitive',
				interactionPolicy: { '@id': 'https://gotosocial.org/ns#interactionPolicy', '@type': '@id' },
				canQuote: { '@id': 'https://gotosocial.org/ns#canQuote', '@type': '@id' },
				automaticApproval: { '@id': 'https://gotosocial.org/ns#automaticApproval', '@type': '@id' },
				manualApproval: { '@id': 'https://gotosocial.org/ns#manualApproval', '@type': '@id' },
			},
		],
		id: uri,
		type: poll ? 'Question' : 'Note',
		attributedTo: accountUri(env, a),
		published: s.created_at,
		...(s.edited_at ? { updated: s.edited_at } : {}),
		url: s.url || `${env.PUBLIC_ORIGIN}/@${a.username}/${s.id}`,
		content: s.content,
		...(s.language ? { contentMap: { [s.language]: s.content } } : {}),
		summary: s.spoiler_text || null,
		sensitive: !!s.sensitive,
		to:
			s.visibility === 'public'
				? [PUBLIC]
				: s.visibility === 'private'
					? [follower, ...recipients]
					: s.visibility === 'direct'
						? recipients
						: [follower],
		cc:
			s.visibility === 'public'
				? [follower, ...recipients]
				: s.visibility === 'unlisted'
					? [PUBLIC, ...recipients]
					: [],
		inReplyTo: parent ? statusUri(env, parent, await accountById(env, parent.account_id)) : null,
		tag: [
			...mentions.map((m) => ({
				type: 'Mention',
				href: accountUri(env, m),
				name: '@' + m.username + (m.domain ? '@' + m.domain : ''),
			})),
			...tags.map((t) => ({
				type: 'Hashtag',
				href: `${env.PUBLIC_ORIGIN}/tags/${encodeURIComponent(t.tag)}`,
				name: '#' + t.tag,
			})),
		],
		attachment: media.map((m) => {
			const json = mediaJSON(env, m)
			return {
				type: 'Document',
				mediaType: m.mime_type,
				url: json.url,
				name: m.description,
				width: parsed<{ original?: { width?: number } }>(m.metadata, {}).original?.width ?? null,
				height: parsed<{ original?: { height?: number } }>(m.metadata, {}).original?.height ?? null,
			}
		}),
		...(poll
			? {
					endTime: poll.expires_at,
					closed: poll.expired ? poll.expires_at : undefined,
					[poll.multiple ? 'anyOf' : 'oneOf']: poll.options.map((o) => ({
						type: 'Note',
						name: o.title,
						replies: { type: 'Collection', totalItems: o.votes_count ?? 0 },
					})),
				}
			: {}),
		...(quote
			? {
					quote: statusUri(env, quote, await accountById(env, quote.account_id)),
					quoteAuthorization: s.quote_authorization,
				}
			: {}),
		interactionPolicy: {
			canQuote: {
				automaticApproval: s.quote_policy === 'public' ? [PUBLIC] : s.quote_policy === 'followers' ? [follower] : [],
				manualApproval: [],
			},
		},
	}
}
