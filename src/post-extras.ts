import type { AccountRow, Env, StatusRow } from './types'
import { accountById, accountUri, all, one, object, list, now, parsed, statusUri } from './data'
import { ApiError, boolField, escapeHtml, stringField } from './http'
import { nextId } from './db'
import { visible, blocked } from './policy'
import { resolveAccount } from './federation'
import { outboundStatement } from './federation/outbox'

export function characterCount(text: string) {
	const weighted = text
		.replace(/https?:\/\/[^\s<>]+/g, 'x'.repeat(23))
		.replace(/@([A-Za-z0-9_]+)@[A-Za-z0-9.-]+/g, '@$1')
	return [...new Intl.Segmenter().segment(weighted)].length
}
export async function postExtras(
	env: Env,
	account: AccountRow,
	id: string,
	input: Record<string, unknown>,
	text: string,
	visibility: StatusRow['visibility'],
	previous?: StatusRow
) {
	const mentions: AccountRow[] = [],
		tags: string[] = [],
		pieces: string[] = [],
		pattern =
			/https?:\/\/[^\s<>]+|(?<![\p{L}\p{N}_])@[A-Za-z0-9_]+(?:@[A-Za-z0-9.-]+)?|(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]+/gu
	let end = 0
	for (const match of text.matchAll(pattern)) {
		pieces.push(escapeHtml(text.slice(end, match.index)))
		const token = match[0]
		if (token.startsWith('@')) {
			const a = await resolveAccount(env, token)
			if (await blocked(env, account.id, a.id)) throw new ApiError(422, 'Cannot mention a blocked account')
			if (!mentions.some((m) => m.id === a.id)) mentions.push(a)
			pieces.push(
				`<span class="h-card"><a href="${escapeHtml(a.url || `${env.PUBLIC_ORIGIN}/@${a.username}`)}" class="u-url mention">@<span>${escapeHtml(a.username)}</span></a></span>`
			)
		} else if (token.startsWith('#')) {
			const name = token.slice(1).normalize('NFKC').toLocaleLowerCase()
			if (!tags.includes(name)) tags.push(name)
			pieces.push(
				`<a href="${env.PUBLIC_ORIGIN}/tags/${encodeURIComponent(name)}" class="mention hashtag" rel="tag">#<span>${escapeHtml(token.slice(1))}</span></a>`
			)
		} else {
			let link = token,
				tail = ''
			while (/[.,!?:;)]$/.test(link)) {
				tail = link.slice(-1) + tail
				link = link.slice(0, -1)
			}
			pieces.push(
				`<a href="${escapeHtml(link)}" rel="nofollow noopener noreferrer" target="_blank">${escapeHtml(link)}</a>${escapeHtml(tail)}`
			)
		}
		end = match.index + token.length
	}
	pieces.push(escapeHtml(text.slice(end)))
	const content = text ? '<p>' + pieces.join('').replace(/\n/g, '<br>') + '</p>' : ''
	const policy = stringField(input, 'quote_approval_policy', previous?.quote_policy ?? 'public')
	if (!['public', 'followers', 'nobody'].includes(policy)) throw new ApiError(422, 'Invalid quote approval policy')
	const quoteId =
		input.quoted_status_id === undefined ? (previous?.quote_id ?? null) : stringField(input, 'quoted_status_id') || null
	let quoteState = previous?.quote_state ?? null,
		authorization = previous?.quote_authorization ?? null,
		quote: StatusRow | null = null
	if (previous && quoteId !== previous.quote_id)
		throw new ApiError(422, 'A quote target cannot be changed after posting')
	if (quoteId && !previous) {
		quote = await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', quoteId)
		if (
			!quote ||
			!(await visible(env, quote, account.id)) ||
			quote.reblog_of_id ||
			!['public', 'unlisted'].includes(quote.visibility)
		)
			throw new ApiError(422, 'This post cannot be quoted')
		if (quote.visibility === 'private' && visibility !== 'private')
			throw new ApiError(422, 'A followers-only quote must remain followers-only')
		const follows = await one(
			env,
			"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
			account.id,
			quote.account_id
		)
		if (
			quote.account_id !== account.id &&
			(quote.quote_policy === 'nobody' || (quote.quote_policy === 'followers' && !follows))
		)
			throw new ApiError(422, 'The author does not permit this quote')
		quoteState = quote.local ? 'accepted' : 'pending'
		authorization = quote.local ? `${env.PUBLIC_ORIGIN}/quote_authorizations/${id}` : null
	}
	let poll: null | { id: string; options: string[]; multiple: boolean; hide: boolean; expires: string } = null
	const prior = previous
		? await one<{ id: string; options: string; multiple: number; hide_totals: number; expires_at: string }>(
				env,
				'SELECT * FROM polls WHERE status_id=?',
				id
			)
		: null
	if (input.poll !== undefined && input.poll !== null) {
		const p = object(input.poll),
			options = list(p.options ?? (prior ? JSON.parse(prior.options) : undefined), 4),
			duration = Number(p.expires_in ?? (prior ? (Date.parse(prior.expires_at) - Date.now()) / 1000 : 0))
		if (
			options.length < 2 ||
			options.some((v) => !v.trim() || characterCount(v) > 50) ||
			new Set(options).size !== options.length ||
			(Array.isArray(p.options) && p.options.length !== options.length) ||
			!Number.isFinite(duration) ||
			((!prior || p.expires_in !== undefined) && (duration < 300 || duration > 2629746))
		)
			throw new ApiError(422, 'Use 2–4 distinct poll options (50 characters each), expiring in 5 minutes to one month')
		poll = {
			id: prior?.id ?? (await nextId(env.DB)),
			options,
			multiple: boolField(p, 'multiple', !!prior?.multiple),
			hide: boolField(p, 'hide_totals', !!prior?.hide_totals),
			expires:
				p.expires_in === undefined && prior ? prior.expires_at : new Date(Date.now() + duration * 1000).toISOString(),
		}
	}
	if (previous && input.poll === undefined && prior)
		poll = {
			id: prior.id,
			options: JSON.parse(prior.options),
			multiple: !!prior.multiple,
			hide: !!prior.hide_totals,
			expires: prior.expires_at,
		}
	return {
		content,
		mentions,
		tags,
		quoteId,
		quoteState,
		authorization,
		policy,
		poll,
		statements: (mutation: string) => {
			const guard = 'EXISTS(SELECT 1 FROM statuses WHERE id=? AND mutation_id=?)',
				statements: D1PreparedStatement[] = []
			statements.push(
				env.DB.prepare(
					`UPDATE statuses SET quote_id=?,quote_state=?,quote_policy=?,quote_authorization=? WHERE id=? AND mutation_id=?`
				).bind(quoteId, quoteState, policy, authorization, id, mutation)
			)
			// Edits retain explicit recipients to avoid leaking or withdrawing a direct
			// conversation unexpectedly; new mentions are added atomically with the edit.
			for (const a of mentions)
				statements.push(
					env.DB.prepare(
						`INSERT OR IGNORE INTO status_recipients(status_id,account_id) SELECT ?,? WHERE ${guard}`
					).bind(id, a.id, id, mutation)
				)
			statements.push(env.DB.prepare(`DELETE FROM status_tags WHERE status_id=? AND ${guard}`).bind(id, id, mutation))
			for (const tag of tags)
				statements.push(
					env.DB.prepare(`INSERT OR IGNORE INTO tags(name,display_name,created_at) SELECT ?,?,? WHERE ${guard}`).bind(
						tag,
						tag,
						now(),
						id,
						mutation
					),
					env.DB.prepare(`INSERT OR IGNORE INTO status_tags(status_id,tag) SELECT ?,? WHERE ${guard}`).bind(
						id,
						tag,
						id,
						mutation
					)
				)
			if (poll) {
				if (prior && JSON.stringify(poll.options) !== prior.options)
					statements.push(
						env.DB.prepare(`DELETE FROM poll_votes WHERE poll_id=? AND ${guard}`).bind(prior.id, id, mutation),
						env.DB.prepare(`DELETE FROM poll_ballots WHERE poll_id=? AND ${guard}`).bind(prior.id, id, mutation)
					)
				statements.push(
					env.DB.prepare(
						`INSERT INTO polls(id,status_id,options,multiple,hide_totals,expires_at) SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT(status_id) DO UPDATE SET options=excluded.options,multiple=excluded.multiple,hide_totals=excluded.hide_totals,expires_at=excluded.expires_at,notified_at=CASE WHEN polls.expires_at<>excluded.expires_at THEN NULL ELSE polls.notified_at END`
					).bind(poll.id, id, JSON.stringify(poll.options), +poll.multiple, +poll.hide, poll.expires, id, mutation)
				)
				statements.push(
					env.DB.prepare(
						`INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) SELECT ?,'poll.close',?,?,? WHERE ${guard}`
					).bind(
						'poll-close:' + poll.id + ':' + poll.expires,
						JSON.stringify({ pollId: poll.id }),
						Date.parse(poll.expires),
						Date.now(),
						id,
						mutation
					)
				)
			} else if (prior) throw new ApiError(422, 'An existing poll cannot be removed')
			return statements
		},
		quoteRequest:
			quote && !quote.local
				? async (mutation: string) => {
						const target = await accountById(env, quote!.account_id)
						return outboundStatement(
							env,
							account.id,
							{
								'@context': [
									'https://www.w3.org/ns/activitystreams',
									{ QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' },
								],
								type: 'QuoteRequest',
								actor: accountUri(env, account),
								object: statusUri(env, quote!, target),
								instrument: `${accountUri(env, account)}/statuses/${id}`,
							},
							[target.id],
							`quote-${id}`,
							{ sql: 'EXISTS(SELECT 1 FROM statuses WHERE id=? AND mutation_id=?)', binds: [id, mutation] }
						)
					}
				: null,
	}
}
