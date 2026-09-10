import { state, esc, api, post, button, message, dialog, bind, resolveAccount } from './api.js'
import { status, person, empty } from './render.js'
import { composer } from './composer.js'
import { settings } from './settings.js'
import { administration } from './admin.js'
import { profileDetail, threadDetail, annualReports } from './detail.js'
const root = document.querySelector('#view'),
	more = document.querySelector('#more')
let next = null,
	socket = null,
	refreshTimer = null
export function compose(options = {}) {
	composer(document.querySelector('#composer'), () => load(), options)
	document.querySelector('#composer').scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function posts(rows, append = false) {
	if (!append) root.replaceChildren()
	for (const row of rows) root.append(status(row, { compose }))
	if (!rows.length && !append) empty(root)
	next = state.next
	more.hidden = !next
}
function links(items) {
	const nav = document.createElement('div')
	nav.className = 'tabs'
	for (const [title, fn] of items) nav.append(button(title, fn, 'quiet'))
	root.append(nav)
}
async function feed(path, append = false) {
	posts(await api(path), append)
}
async function notices() {
	root.replaceChildren()
	const items = document.createElement('section')
	function newList() {
		const list = document.createElement('div')
		items.replaceChildren(list)
		return list
	}
	links([
		['All', () => noticeList(newList())],
		[
			'Filtered requests',
			async () => {
				const list = newList()
				const rows = await api('/api/v1/notifications/requests')
				for (const n of rows) {
					const el = person(n.account)
					el.append(
						button('Accept notifications', async () => {
							await post('/api/v1/notifications/requests/' + n.id + '/accept')
							el.remove()
							if (!list.children.length) empty(list, 'No requests remaining.')
						}),
						button('Dismiss', async () => {
							await post('/api/v1/notifications/requests/' + n.id + '/dismiss')
							el.remove()
							if (!list.children.length) empty(list, 'No requests remaining.')
						})
					)
					list.append(el)
				}
				if (!rows.length) empty(list, 'No filtered notification requests.')
			},
		],
		[
			'Follow requests',
			async () => {
				const list = newList()
				const rows = await api('/api/v1/follow_requests')
				for (const a of rows) {
					const el = person(a)
					el.append(
						button('Approve', async () => {
							await post('/api/v1/follow_requests/' + a.id + '/authorize')
							el.remove()
							if (!list.children.length) empty(list, 'No requests remaining.')
						}),
						button('Reject', async () => {
							await post('/api/v1/follow_requests/' + a.id + '/reject')
							el.remove()
							if (!list.children.length) empty(list, 'No requests remaining.')
						})
					)
					list.append(el)
				}
				if (!rows.length) empty(list, 'No follow requests.')
			},
		],
		[
			'Clear notifications',
			async () => {
				await post('/api/v1/notifications/clear')
				await notices()
			},
		],
	])
	root.append(items)
	await noticeList(newList())
}
async function noticeList(list) {
	const rows = await api('/api/v1/notifications')
	for (const n of rows) {
		const el = document.createElement('article')
		el.innerHTML = `<p><strong>${esc(n.account.display_name || n.account.acct)}</strong> · ${esc(n.type.replaceAll('_', ' '))}</p>`
		if (n.status) el.append(status(n.status, { compose }))
		if (n.moderation_warning) {
			const notice = document.createElement('p')
			notice.textContent = n.moderation_warning.action + ': ' + n.moderation_warning.text
			el.append(notice)
		}
		if (n.report) {
			const link = document.createElement('a')
			link.href = '/admin'
			link.textContent = 'Review report: ' + n.report.category
			el.append(link)
		}
		if (n.collection) {
			const a = button(n.collection.name, () => collectionDetail(n.collection.id))
			el.append(a)
		}
		if (n.event) {
			const detail = document.createElement('p')
			detail.textContent = `${n.event.target_name}: ${n.event.following_count} following and ${n.event.followers_count} followers disconnected.`
			const link = document.createElement('a')
			link.href = '/settings'
			link.textContent = 'Export affected relationships in Import and export'
			el.append(detail, link)
		}
		el.append(
			button(
				'Dismiss',
				async () => {
					await post('/api/v1/notifications/' + n.id + '/dismiss')
					el.remove()
					if (!list.children.length) empty(list, 'No notifications.')
				},
				'quiet'
			)
		)
		list.append(el)
	}
	if (!rows.length) empty(list, 'No notifications.')
	if (rows[0]) await post('/api/v1/markers', { notifications: { last_read_id: rows[0].id } })
}
async function listManager() {
	root.replaceChildren()
	root.append(button('New list', () => editList()))
	for (const list of await api('/api/v1/lists')) {
		const el = document.createElement('article')
		el.innerHTML = `<h2>${esc(list.title)}</h2>`
		el.append(
			button('Read list', () => feed('/api/v1/timelines/list/' + list.id)),
			button('Edit', () => editList(list)),
			button('Members', () => listMembers(list)),
			button(
				'Delete',
				async () => {
					await api('/api/v1/lists/' + list.id, { method: 'DELETE' })
					el.remove()
				},
				'danger'
			)
		)
		root.append(el)
	}
}
function editList(list) {
	const d = dialog(
		list ? 'Edit list' : 'New list',
		`<form><label>Name<input name="title" maxlength="100" required value="${esc(list?.title)}"></label><label>Replies<select name="replies_policy"><option value="list">List members</option><option value="followed">People you follow</option><option value="none">No replies</option></select></label><label><input type="checkbox" name="exclusive" ${list?.exclusive ? 'checked' : ''}> Hide these people from Home</label><button>Save</button></form>`
	)
	d.querySelector('[name=replies_policy]').value = list?.replies_policy ?? 'list'
	bind(d.querySelector('form'), async (f) => {
		await api('/api/v1/lists' + (list ? '/' + list.id : ''), {
			method: list ? 'PUT' : 'POST',
			body: { title: f.get('title'), replies_policy: f.get('replies_policy'), exclusive: f.has('exclusive') },
		})
		d.close()
		await listManager()
	})
}
async function listMembers(list) {
	root.innerHTML = `<h2>${esc(list.title)}</h2><form><label>Add an account you follow<input name="acct" placeholder="@name@example.social" required></label><button>Add</button></form>`
	bind(root.querySelector('form'), async (f) => {
		const a = await resolveAccount(f.get('acct'))
		await post('/api/v1/lists/' + list.id + '/accounts', { account_ids: [a.id] })
		await listMembers(list)
	})
	for (const a of await api('/api/v1/lists/' + list.id + '/accounts')) {
		const el = person(a)
		el.append(
			button('Remove from list', async () => {
				await api('/api/v1/lists/' + list.id + '/accounts', { method: 'DELETE', body: { account_ids: [a.id] } })
				el.remove()
			})
		)
		root.append(el)
	}
}
async function collectionManager() {
	root.replaceChildren()
	root.append(button('New collection', () => editCollection()))
	const data = await api('/api/v1/accounts/' + state.account.id + '/collections')
	for (const c of data.collections) {
		const el = document.createElement('article')
		el.innerHTML = `<h2>${esc(c.name)}</h2><p>${esc(c.description || '')}</p>`
		el.append(
			button('Open', () => collectionDetail(c.id)),
			button('Edit', () => editCollection(c)),
			button(
				'Delete',
				async () => {
					await api('/api/v1/collections/' + c.id, { method: 'DELETE' })
					el.remove()
				},
				'danger'
			)
		)
		root.append(el)
	}
	root.append(
		button('Collections featuring me', async () => {
			const result = await api('/api/v1/accounts/' + state.account.id + '/in_collections')
			root.replaceChildren()
			for (const c of result.collections) root.append(button(c.name, () => collectionDetail(c.id)))
		})
	)
}
function editCollection(c) {
	const d = dialog(
		c ? 'Edit collection' : 'New collection',
		`<form><label>Name<input name="name" maxlength="40" required value="${esc(c?.name)}"></label><label>Description<textarea name="description" maxlength="100">${esc(c?.description)}</textarea></label><label>Topic hashtag<input name="tag_name" value="${esc(c?.tag?.name)}"></label><label><input type="checkbox" name="discoverable" ${c?.discoverable ? 'checked' : ''}> Discoverable</label><label><input type="checkbox" name="sensitive" ${c?.sensitive ? 'checked' : ''}> Sensitive</label><button>Save</button></form>`
	)
	bind(d.querySelector('form'), async (f) => {
		await api('/api/v1/collections' + (c ? '/' + c.id : ''), {
			method: c ? 'PUT' : 'POST',
			body: {
				name: f.get('name'),
				description: f.get('description'),
				tag_name: f.get('tag_name'),
				discoverable: f.has('discoverable'),
				sensitive: f.has('sensitive'),
			},
		})
		d.close()
		await collectionManager()
	})
}
async function collectionDetail(id) {
	const { collection: c, accounts } = await api('/api/v1/collections/' + id),
		owner = c.account_id === state.account?.id
	root.innerHTML = `<h2>${esc(c.name)}</h2><p>${esc(c.description || '')}</p>${owner ? '<form><label>Add account<input name="acct" required placeholder="@name@example.social"></label><button>Add</button></form>' : ''}`
	if (owner)
		bind(root.querySelector('form'), async (f) => {
			const a = await resolveAccount(f.get('acct'))
			await post('/api/v1/collections/' + id + '/items', { account_id: a.id })
			await collectionDetail(id)
		})
	for (const item of c.items) {
		const a = accounts.find((a) => a.id === item.account_id),
			el = a ? person(a) : document.createElement('article')
		const label = document.createElement('p')
		label.textContent = item.state
		el.append(label)
		if (owner)
			el.append(
				button('Remove', async () => {
					await api('/api/v1/collections/' + id + '/items/' + item.id, { method: 'DELETE' })
					el.remove()
				})
			)
		else if (item.account_id === state.account?.id)
			el.append(
				button('Remove me from collection', async () => {
					await post('/api/v1/collections/' + id + '/items/' + item.id + '/revoke')
					el.remove()
				})
			)
		root.append(el)
	}
}
async function scheduled() {
	root.replaceChildren()
	const rows = await api('/api/v1/scheduled_statuses')
	for (const s of rows) {
		const el = document.createElement('article')
		el.innerHTML = `<p>${esc(s.params.text || s.params.status)}</p><form><label>Scheduled for<input type="datetime-local" name="date" required value="${new Date(new Date(s.scheduled_at) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}"></label><button>Reschedule</button></form>`
		bind(el.querySelector('form'), async (f) => {
			await api('/api/v1/scheduled_statuses/' + s.id, {
				method: 'PUT',
				body: { scheduled_at: new Date(f.get('date')).toISOString() },
			})
			message('Schedule updated.')
		})
		el.append(
			button(
				'Cancel post',
				async () => {
					await api('/api/v1/scheduled_statuses/' + s.id, { method: 'DELETE' })
					el.remove()
				},
				'danger'
			)
		)
		root.append(el)
	}
	if (!rows.length) empty(root)
}
async function conversations() {
	root.replaceChildren()
	const rows = await api('/api/v1/conversations')
	for (const c of rows) {
		const el = document.createElement('article')
		el.innerHTML = `<h2>${c.unread ? '● ' : ''}${esc(c.accounts.map((a) => '@' + a.acct).join(', '))}</h2>`
		if (c.last_status) el.append(status(c.last_status, { compose }))
		el.append(
			button('Mark read', async () => {
				await post('/api/v1/conversations/' + c.id + '/read')
				el.querySelector('h2').textContent = c.accounts.map((a) => '@' + a.acct).join(', ')
			}),
			button('Remove from inbox', async () => {
				await api('/api/v1/conversations/' + c.id, { method: 'DELETE' })
				el.remove()
			})
		)
		root.append(el)
	}
	if (!rows.length) empty(root)
}
async function search() {
	root.innerHTML =
		'<form><label>People, posts or hashtags<input name="q" type="search" required placeholder="Search, @name@server or a post URL"></label><button>Search</button></form><div id="results"></div>'
	bind(root.querySelector('form'), async (f) => {
		const data = await api('/api/v2/search?resolve=true&q=' + encodeURIComponent(f.get('q'))),
			list = root.querySelector('#results')
		list.replaceChildren()
		for (const a of data.accounts) list.append(person(a))
		for (const s of data.statuses) list.append(status(s, { compose }))
		for (const t of data.hashtags)
			list.append(
				button('#' + t.name, () => {
					location.href = '/tags/' + encodeURIComponent(t.name)
				})
			)
		if (!list.children.length) empty(list, 'No results found.')
	})
}
async function explore() {
	root.replaceChildren()
	const items = document.createElement('section')
	function newList() {
		const list = document.createElement('div')
		items.replaceChildren(list)
		return list
	}
	async function show(path, render, emptyText, list = newList()) {
		const rows = await api(path),
			page = state.next
		for (const row of rows) list.append(render(row))
		if (!list.children.length) empty(list, emptyText)
		if (page) {
			const loadMore = button('Load more', async () => {
				await show(page, render, emptyText, list)
				loadMore.remove()
			})
			list.append(loadMore)
		}
	}
	const showPosts = () => show('/api/v1/trends/statuses', (s) => status(s, { compose }), 'No trending posts yet.')
	links([
		['Posts', showPosts],
		['People', () => show('/api/v1/directory?order=active', person, 'No people to show yet.')],
		[
			'Hashtags',
			() =>
				show(
					'/api/v1/trends/tags',
					(t) =>
						button('#' + t.name, () => {
							location.href = '/tags/' + encodeURIComponent(t.name)
						}),
					'No trending hashtags yet.'
				),
		],
		[
			'Links',
			() =>
				show(
					'/api/v1/trends/links',
					(l) => {
						const el = document.createElement('article')
						el.innerHTML = `<a href="${esc(l.url)}" rel="noopener noreferrer">${esc(l.title)}</a><p>${esc(l.description)}</p>`
						return el
					},
					'No trending links yet.'
				),
		],
	])
	root.append(items)
	await showPosts()
}
async function load() {
	more.hidden = true
	next = null
	root.setAttribute('aria-busy', 'true')
	const path = location.pathname,
		view = path.split('/')[1] || 'home'
	document.querySelector('#view-title').textContent =
		{ home: 'Home', public: 'Live feed', scheduled_statuses: 'Scheduled posts' }[view] ??
		view.charAt(0).toUpperCase() + view.slice(1)
	try {
		if (view === 'accounts') await profileDetail(root, path.split('/')[2], compose)
		else if (view === 'statuses' || (view.startsWith('@') && path.split('/')[2]))
			await threadDetail(root, path.split('/')[2], compose)
		else if (view.startsWith('@'))
			await profileDetail(
				root,
				(await api('/api/v1/accounts/lookup?acct=' + encodeURIComponent(view.slice(1)))).id,
				compose
			)
		else if (view === 'annual_reports') await annualReports(root)
		else if (path.startsWith('/settings')) await settings(root)
		else if (view === 'admin') await administration(root)
		else if (view === 'home') await feed('/api/v1/timelines/home')
		else if (view === 'public') await feed('/api/v1/timelines/public')
		else if (view === 'bookmarks' || view === 'favourites') await feed('/api/v1/' + view)
		else if (view === 'notifications') await notices()
		else if (view === 'lists') await listManager()
		else if (view === 'collections')
			path.split('/')[2] ? await collectionDetail(path.split('/')[2]) : await collectionManager()
		else if (view === 'scheduled_statuses') await scheduled()
		else if (view === 'conversations') await conversations()
		else if (view === 'search') await search()
		else if (view === 'explore') await explore()
		else if (view === 'tags') {
			const tag = decodeURIComponent(path.split('/')[2])
			await feed('/api/v1/timelines/tag/' + encodeURIComponent(tag))
			if (state.account)
				root.prepend(
					button('Follow #' + tag, async () => {
						await post('/api/v1/tags/' + encodeURIComponent(tag) + '/follow')
						message('Hashtag followed.')
					})
				)
		}
	} catch (error) {
		message(error.message, true)
	} finally {
		root.setAttribute('aria-busy', 'false')
	}
}
function stream() {
	if (!state.token || document.hidden) return
	socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/v1/streaming?stream=user', [state.token])
	socket.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data)
			if (data.event === 'delete') {
				for (const el of root.querySelectorAll('[data-id]')) if (el.dataset.id === data.payload) el.remove()
			} else if (['update', 'status.update', 'notification', 'conversation'].includes(data.event)) {
				message('New activity is available. Select Refresh to update your view.')
			}
		} catch {}
	}
	socket.onclose = () => {
		socket = null
		if (!document.hidden) refreshTimer = setTimeout(stream, 30000)
	}
}
document.addEventListener('visibilitychange', () => {
	clearTimeout(refreshTimer)
	if (document.hidden) socket?.close()
	else if (!socket) stream()
})
document.querySelector('#refresh').onclick = () => {
	message('')
	load()
}
more.onclick = async () => {
	if (next) {
		const path = next
		more.disabled = true
		try {
			await feed(path, true)
		} catch (error) {
			message(error.message, true)
		} finally {
			more.disabled = false
		}
	}
}
try {
	state.instance = await api('/api/v2/instance')
	document.querySelector('#instance-description').textContent = state.instance.description
	const response = await fetch('/api/hyena/session', { credentials: 'same-origin' })
	if (response.ok) {
		const session = await response.json()
		state.token = session.access_token
		state.csrf = session.csrf
		state.account = session.account
		document.querySelector('#identity').innerHTML =
			`<p>@${esc(state.account.acct)}</p><form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(state.csrf)}"><button class="quiet">Sign out</button></form>`
		document.querySelector('#admin-link').hidden = !state.account.roles?.some((r) =>
			['Admin', 'Moderator'].includes(r.name)
		)
		if (location.pathname === '/') compose()
		stream()
		const notices = await api('/api/v1/announcements')
		for (const n of notices) {
			const el = document.createElement('article')
			el.innerHTML = n.content
			for (const r of n.reactions)
				el.append(
					button(
						r.name + ' ' + r.count,
						async (b) => {
							await api('/api/v1/announcements/' + n.id + '/reactions/' + encodeURIComponent(r.name), {
								method: r.me ? 'DELETE' : 'PUT',
							})
							r.me = !r.me
							r.count += r.me ? 1 : -1
							b.textContent = r.name + ' ' + r.count
						},
						r.me ? 'active' : ''
					)
				)
			el.append(
				button(
					'React',
					async () => {
						const d = dialog(
							'React to announcement',
							'<form><label>Emoji<input name="name" required maxlength="64" value="👍"></label><button>Add reaction</button></form>'
						)
						bind(d.querySelector('form'), async (f) => {
							await api('/api/v1/announcements/' + n.id + '/reactions/' + encodeURIComponent(f.get('name')), {
								method: 'PUT',
							})
							d.close()
							message('Reaction added.')
						})
					},
					'quiet'
				)
			)
			el.append(
				button(
					'Dismiss',
					async () => {
						await post('/api/v1/announcements/' + n.id + '/dismiss')
						el.remove()
					},
					'quiet'
				)
			)
			document.querySelector('#announcements').append(el)
		}
	} else document.querySelector('#identity').innerHTML = '<a href="/login">Sign in</a>'
	await load()
} catch (error) {
	message(error.message, true)
}
