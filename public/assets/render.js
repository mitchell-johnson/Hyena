import { state, esc, api, post, button, message, dialog, bind } from './api.js'
export function empty(root, text = 'Nothing here yet.') {
	root.innerHTML = `<p class="empty">${esc(text)}</p>`
}
export function person(a) {
	const el = document.createElement('article')
	el.className = 'person'
	el.innerHTML = `<header><img class="avatar" src="${esc(a.avatar)}" alt="" loading="lazy"><div class="byline"><a href="/accounts/${esc(a.id)}">${esc(a.display_name || a.username)}</a><small>@${esc(a.acct)}</small></div></header><div class="post-content">${a.note || ''}</div><p class="muted">${a.followers_count} followers · ${a.statuses_count} posts</p>`
	if (state.account && state.account.id !== a.id) {
		const actions = document.createElement('div')
		actions.className = 'post-actions'
		actions.append(
			button('Follow', async (b) => {
				const r = await post('/api/v1/accounts/' + a.id + '/follow')
				b.textContent = r.requested ? 'Requested' : 'Following'
			}),
			button('Unfollow', async () => {
				await post('/api/v1/accounts/' + a.id + '/unfollow')
				message('Account unfollowed.')
			}),
			button('Mute', async () => {
				await post('/api/v1/accounts/' + a.id + '/mute', { notifications: true })
				message('Account muted.')
			}),
			button('Block', async () => {
				await post('/api/v1/accounts/' + a.id + '/block')
				el.remove()
			}),
			button('Add to collection', async () => {
				const data = await api('/api/v1/accounts/' + state.account.id + '/collections'),
					d = dialog(
						'Add to a collection',
						`<form><label>Collection <select name="id">${data.collections.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><button>Add account</button></form>`
					)
				bind(d.querySelector('form'), async (f) => {
					await post('/api/v1/collections/' + f.get('id') + '/items', { account_id: a.id })
					d.close()
					message('Collection updated.')
				})
			})
		)
		el.append(actions)
	}
	return el
}
export function status(s, { compose } = {}) {
	const outer = document.createElement('article')
	outer.className = 'post'
	outer.dataset.id = s.id
	const original = s.reblog
	if (original) {
		const label = document.createElement('p')
		label.className = 'muted'
		label.textContent = (s.account.display_name || s.account.username) + ' boosted'
		outer.append(label)
		outer.append(status(original, { compose }))
		return outer
	}
	const header = document.createElement('header')
	header.innerHTML = `<img class="avatar" src="${esc(s.account.avatar)}" loading="lazy" alt=""><div class="byline"><a href="/accounts/${esc(s.account.id)}">${esc(s.account.display_name || s.account.username)}</a><small>@${esc(s.account.acct)} · ${esc(s.visibility)}</small></div><a href="/statuses/${esc(s.id)}"><time>${new Date(s.created_at).toLocaleString()}</time></a>`
	outer.append(header)
	const content = document.createElement('div')
	content.className = 'post-content'
	content.innerHTML = s.content
	let target = outer
	const filterWarning = s.filtered
		?.filter((f) => f.filter.filter_action === 'warn')
		.map((f) => f.filter.title)
		.join(', ')
	if (s.spoiler_text || s.sensitive || filterWarning) {
		const warning = document.createElement('details')
		warning.innerHTML = `<summary>${esc(filterWarning ? 'Filtered: ' + filterWarning : s.spoiler_text || 'Sensitive media')}</summary>`
		outer.append(warning)
		target = warning
	}
	if (s.filtered?.some((f) => f.filter.filter_action === 'hide')) {
		outer.innerHTML = '<p class="muted">Post hidden by your filters.</p>'
		return outer
	}
	target.append(content)
	if (s.media_attachments?.length) {
		const gallery = document.createElement('div')
		gallery.className = 'media'
		for (const m of s.media_attachments) {
			if (!m.url) continue
			const element = document.createElement(m.type === 'image' ? 'img' : m.type === 'audio' ? 'audio' : 'video')
			if (element.tagName === 'IMG') {
				element.alt = m.description || ''
				element.loading = 'lazy'
			} else {
				element.controls = true
				element.preload = 'none'
				if (m.preview_url && element.tagName === 'VIDEO') element.poster = m.preview_url
			}
			element.src = m.url
			gallery.append(element)
			if (m.description) {
				const description = document.createElement('small')
				description.textContent = m.description
				gallery.append(description)
			}
		}
		target.append(gallery)
	}
	if (s.quote) {
		const q = document.createElement('div')
		q.className = 'quote'
		q.innerHTML = s.quote.quoted_status
			? `<a href="${esc(s.quote.quoted_status.url)}">@${esc(s.quote.quoted_status.account.acct)}</a>${s.quote.quoted_status.content}`
			: `Quote: ${esc(s.quote.state)}`
		target.append(q)
	}
	if (s.poll) {
		const p = s.poll,
			form = document.createElement('form')
		form.innerHTML = `${p.options.map((o, i) => `<label class="poll-option">${state.account && !p.voted && !p.expired ? `<input type="${p.multiple ? 'checkbox' : 'radio'}" name="choice" value="${i}">` : ''} ${esc(o.title)} ${o.votes_count == null ? '' : `<span class="count">${o.votes_count}</span>`}</label>`).join('')}<p class="muted">${p.votes_count} votes · ${p.expired ? 'Closed' : new Date(p.expires_at).toLocaleString()}</p>${state.account && !p.voted && !p.expired ? '<button>Vote</button>' : ''}`
		bind(form, async (f) => {
			await post('/api/v1/polls/' + p.id + '/votes', { choices: f.getAll('choice') })
			outer.replaceWith(status(await api('/api/v1/statuses/' + s.id), { compose }))
		})
		target.append(form)
	}
	if (!state.account) return outer
	const actions = document.createElement('div')
	actions.className = 'post-actions'
	for (const [label, action, on, count] of [
		['Favourite', 'favourite', s.favourited, s.favourites_count],
		['Boost', 'reblog', s.reblogged, s.reblogs_count],
		['Bookmark', 'bookmark', s.bookmarked, null],
	])
		actions.append(
			button(
				label + (count ? ' ' + count : ''),
				async () => {
					await post('/api/v1/statuses/' + s.id + '/' + (on ? 'un' : '') + action)
					outer.replaceWith(status(await api('/api/v1/statuses/' + s.id), { compose }))
				},
				on ? 'active' : ''
			)
		)
	if (compose) {
		actions.append(
			button('Reply', () => compose({ reply: s })),
			button('Quote', () => compose({ quote: s }))
		)
	}
	if (state.account.id === s.account.id) {
		actions.append(
			button('Edit', async () => compose?.({ edit: s, source: await api('/api/v1/statuses/' + s.id + '/source') })),
			button('Delete', async () => {
				const d = dialog('Delete this post?', '<p>This removes the post and sends a deletion to its recipients.</p>')
				d.append(
					button(
						'Delete post',
						async () => {
							await api('/api/v1/statuses/' + s.id, { method: 'DELETE' })
							outer.remove()
							d.close()
						},
						'danger'
					)
				)
			})
		)
	}
	actions.append(
		button('More', async () => {
			const d = dialog('Post options', '')
			d.append(
				button(s.muted ? 'Unmute conversation' : 'Mute conversation', async () => {
					await post('/api/v1/statuses/' + s.id + '/' + (s.muted ? 'unmute' : 'mute'))
					d.close()
				}),
				button('View edit history', async () => {
					const items = await api('/api/v1/statuses/' + s.id + '/history')
					d.innerHTML =
						'<h2>Edit history</h2>' +
						items.map((v) => `<article><time>${esc(v.created_at)}</time>${v.content}</article>`).join('')
					d.append(button('Close', () => d.close()))
				}),
				button('Translate', async () => {
					const translated = await post('/api/v1/statuses/' + s.id + '/translate', {
						lang: navigator.language.split('-')[0],
					})
					content.innerHTML = translated.content
					d.close()
				})
			)
			if (state.account.id === s.account.id) {
				d.append(
					button(s.pinned ? 'Unpin' : 'Pin to profile', async () => {
						await post('/api/v1/statuses/' + s.id + '/' + (s.pinned ? 'unpin' : 'pin'))
						d.close()
					}),
					button('Quote policy', () => {
						d.innerHTML =
							'<h2>Quote policy</h2><form><label>Who may quote this post?<select name="policy"><option value="public">Everyone</option><option value="followers">Followers</option><option value="nobody">Nobody</option></select></label><button>Save</button></form>'
						bind(d.querySelector('form'), async (f) => {
							await api('/api/v1/statuses/' + s.id + '/interaction_policy', {
								method: 'PUT',
								body: { quote_approval_policy: f.get('policy') },
							})
							d.close()
						})
					}),
					button('Manage quotes', async () => {
						const quotes = await api('/api/v1/statuses/' + s.id + '/quotes')
						d.innerHTML = '<h2>Quotes</h2>'
						for (const q of quotes) {
							const row = document.createElement('div')
							row.textContent = '@' + q.account.acct
							row.append(
								button('Revoke quote', async () => {
									await post('/api/v1/statuses/' + s.id + '/quotes/' + q.id + '/revoke')
									row.remove()
								})
							)
							d.append(row)
						}
					})
				)
			} else
				d.append(
					button('Report', () => {
						d.innerHTML =
							'<h2>Report this post</h2><form><label>Reason <textarea name="comment" maxlength="1000" required></textarea></label><label><input type="checkbox" name="forward"> Also send to the account’s server</label><button>Send report</button></form>'
						bind(d.querySelector('form'), async (f) => {
							await post('/api/v1/reports', {
								account_id: s.account.id,
								status_ids: [s.id],
								comment: f.get('comment'),
								forward: f.has('forward'),
							})
							d.close()
							message('Report sent.')
						})
					})
				)
		})
	)
	outer.append(actions)
	return outer
}
