import { state, api, post, esc, button, bind, message, dialog } from './api.js'
import { person, status, empty } from './render.js'
export async function profileDetail(root, id, compose) {
	const a = await api('/api/v1/accounts/' + encodeURIComponent(id))
	root.replaceChildren(person(a))
	if (a.moved) {
		const note = document.createElement('p')
		note.textContent = 'This account has moved to @' + a.moved.acct
		root.append(note, person(a.moved))
	}
	const tabs = document.createElement('div'),
		items = document.createElement('section')
	tabs.className = 'tabs'
	root.append(tabs, items)
	async function show(path, kind, append = false) {
		const rows = await api(path),
			next = state.next
		if (!append) items.replaceChildren()
		for (const row of rows) items.append(kind === 'posts' ? status(row, { compose }) : person(row))
		if (!rows.length && !append) empty(items)
		if (next) {
			const more = button('Load more', async () => {
				more.remove()
				await show(next, kind, true)
			})
			items.append(more)
		}
	}
	for (const [label, suffix, kind] of [
		['Posts', 'statuses', 'posts'],
		['Pinned posts', 'statuses?pinned=true', 'posts'],
		['Followers', 'followers', 'people'],
		['Following', 'following', 'people'],
	])
		tabs.append(button(label, () => show('/api/v1/accounts/' + id + '/' + suffix, kind), 'quiet'))
	tabs.append(
		button(
			'Collections',
			async () => {
				const data = await api('/api/v1/accounts/' + id + '/collections')
				items.replaceChildren()
				for (const c of data.collections) {
					const el = document.createElement('article')
					el.innerHTML = `<h2>${esc(c.name)}</h2><p>${esc(c.description)}</p><a href="/collections/${esc(c.id)}">Open collection</a>`
					items.append(el)
				}
				if (!data.collections.length) empty(items)
			},
			'quiet'
		)
	)
	if (state.account && a.id !== state.account.id)
		tabs.append(
			button(
				'Relationship options',
				async () => {
					const [r] = await api('/api/v1/accounts/relationships?id[]=' + id),
						d = dialog(
							'Relationship options',
							`<form><label>Private note<textarea name="comment" maxlength="2000">${esc(r.note)}</textarea></label><label><input type="checkbox" name="notify" ${r.notifying ? 'checked' : ''}> Notify me about posts</label><label><input type="checkbox" name="reblogs" ${r.showing_reblogs ? 'checked' : ''}> Show boosts</label><label>Languages (comma separated, blank for all)<input name="languages" value="${esc((r.languages ?? []).join(','))}"></label><button>Save</button></form>`
						)
					bind(d.querySelector('form'), async (f) => {
						await post('/api/v1/accounts/' + id + '/note', { comment: f.get('comment') })
						if (r.following)
							await post('/api/v1/accounts/' + id + '/follow', {
								notify: f.has('notify'),
								reblogs: f.has('reblogs'),
								languages: f
									.get('languages')
									.split(',')
									.map((x) => x.trim())
									.filter(Boolean),
							})
						d.close()
						message('Relationship updated.')
					})
					for (const [label, action] of [
						[r.endorsed ? 'Remove recommendation' : 'Recommend account', r.endorsed ? 'unpin' : 'pin'],
						['Remove follower', 'remove_from_followers'],
					])
						d.append(
							button(label, async () => {
								await post('/api/v1/accounts/' + id + '/' + action)
								d.close()
							})
						)
				},
				'quiet'
			)
		)
	await show('/api/v1/accounts/' + id + '/statuses', 'posts')
}
export async function threadDetail(root, id, compose) {
	const s = await api('/api/v1/statuses/' + id),
		context = await api('/api/v1/statuses/' + id + '/context')
	root.replaceChildren()
	for (const row of context.ancestors) root.append(status(row, { compose }))
	const focal = status(s, { compose })
	focal.classList.add('focal')
	root.append(focal)
	for (const row of context.descendants) root.append(status(row, { compose }))
	if (state.account) root.append(button('Reply to this post', () => compose({ reply: s })))
	focal.scrollIntoView({ block: 'center' })
}
export async function annualReports(root) {
	root.innerHTML =
		'<h2>Your year in posts</h2><p>Reports become available during the instance’s annual report campaign.</p>'
	const list = await api('/api/v1/annual_reports')
	async function show(r) {
		const el = document.createElement('article'),
			data = r.data
		el.innerHTML = `<h2>${r.year} · ${esc(data.archetype)}</h2><p>${data.time_series.reduce((n, m) => n + m.statuses, 0)} posts this year</p><table><thead><tr><th>Period</th><th>Posts</th><th>New followers</th></tr></thead><tbody>${data.time_series.map((m) => `<tr><td>${data.time_series.length === 1 ? 'Year total' : m.month}</td><td>${m.statuses}</td><td>${m.followers}</td></tr>`).join('')}</tbody></table><p>${data.top_hashtags.map((t) => '#' + esc(t.name) + ' (' + t.count + ')').join(' · ')}</p>${r.share_url ? `<p><a href="${esc(r.share_url)}">Share this report</a></p>` : ''}`
		el.append(
			button('Mark as read', async () => {
				await post('/api/v1/annual_reports/' + r.year + '/read')
				el.remove()
			})
		)
		root.append(el)
	}
	for (const r of list.annual_reports) await show(r)
	const year = new Date().getUTCFullYear(),
		eligibility = await api('/api/v1/annual_reports/' + year + '/state')
	if (eligibility.state === 'eligible')
		root.append(
			button('Generate ' + year + ' report', async () => {
				await post('/api/v1/annual_reports/' + year + '/generate')
				await annualReports(root)
			})
		)
	else if (eligibility.state === 'available' && !list.annual_reports.some((r) => r.year === year))
		root.append(
			button('View ' + year, async () => {
				for (const r of (await api('/api/v1/annual_reports/' + year)).annual_reports) await show(r)
			})
		)
}
