import { state, esc, api, post, bind, button, dialog, message, download, resolveAccount } from './api.js'
import { person, empty } from './render.js'
import { credential } from './passkeys.js'
const cookie = (path, method = 'GET', body) => api(path, { method, body, cookie: true })
const box = (name, title, checked = false) =>
	`<label><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${title}</label>`
export async function settings(root) {
	root.replaceChildren()
	const nav = document.createElement('div')
	nav.className = 'tabs'
	const content = document.createElement('section')
	const views = {
		Profile: profile,
		Preferences: preferences,
		Security: security,
		Apps: apps,
		'Blocks and mutes': blocks,
		Filters: filters,
		Hashtags: tags,
		'Import and export': transfers,
		Account: account,
	}
	for (const [title, fn] of Object.entries(views)) nav.append(button(title, () => fn(content), 'quiet'))
	root.append(nav, content)
	await (location.pathname.endsWith('/apps') ? apps : profile)(content)
}
async function profile(root) {
	const p = await api('/api/v1/profile')
	root.innerHTML = `<form class="panel"><h2>Profile</h2><label>Display name<input name="display_name" maxlength="30" value="${esc(p.display_name)}"></label><label>Bio<textarea name="note" maxlength="500">${esc(p.note)}</textarea></label>${['avatar', 'header'].map((k) => `<label>${k === 'avatar' ? 'Avatar' : 'Header image'}<input type="file" name="${k}" accept="image/jpeg,image/png,image/webp"></label><label>Image description<input name="${k}_description" maxlength="1500" value="${esc(p[k + '_description'])}"></label>`).join('')}${box('locked', 'Approve followers', p.locked)}${box('bot', 'Automated account', p.bot)}${box('discoverable', 'Appear in the directory and recommendations', p.discoverable)}${box('indexable', 'Include public posts in search', p.indexable)}${box('hide_collections', 'Hide my collections on my profile', p.hide_collections)}<h3>Profile fields</h3>${Array.from({ length: 4 }, (_, i) => `<div class="row"><label>Label<input name="fields_attributes[${i}][name]" maxlength="255" value="${esc(p.fields[i]?.name)}"></label><label>Value<input name="fields_attributes[${i}][value]" maxlength="255" value="${esc(p.fields[i]?.value)}"></label></div>`).join('')}<button>Save profile</button></form>`
	bind(root.querySelector('form'), async (f) => {
		for (const k of ['locked', 'bot', 'discoverable', 'indexable', 'hide_collections']) f.set(k, String(f.has(k)))
		for (const k of ['avatar', 'header']) if (!f.get(k)?.size) f.delete(k)
		await api('/api/v1/profile', { method: 'PATCH', body: f })
		state.account = await api('/api/v1/accounts/verify_credentials')
		message('Profile updated.')
	})
	for (const k of ['avatar', 'header'])
		if (p[k])
			root.append(
				button(
					'Remove ' + k,
					async () => {
						await api('/api/v1/profile/' + k, { method: 'DELETE' })
						await profile(root)
					},
					'quiet'
				)
			)
}
async function preferences(root) {
	const p = await api('/api/v1/preferences'),
		policy = await api('/api/v2/notifications/policy')
	root.innerHTML = `<form class="panel"><h2>Posting preferences</h2><label>Default audience<select name="privacy"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Followers</option><option value="direct">Mentioned people</option></select></label><label>Default language<input name="language" value="${esc(p['posting:default:language'] || '')}"></label>${box('sensitive', 'Mark media sensitive by default', p['posting:default:sensitive'])}<button>Save defaults</button></form><form id="notification-policy" class="panel"><h2>Notification requests</h2>${Object.entries(
		policy
	)
		.filter(([k, v]) => k.startsWith('for_') && typeof v === 'string')
		.map(
			([k, v]) =>
				`<label>${esc(k.slice(4).replaceAll('_', ' '))}<select name="${k}">${['accept', 'filter', 'drop'].map((x) => `<option ${v === x ? 'selected' : ''} value="${x}">${x}</option>`).join('')}</select></label>`
		)
		.join('')}<button>Save notification policy</button></form>`
	root.querySelector('[name=privacy]').value = p['posting:default:visibility']
	bind(root.querySelector('form'), async (f) => {
		await api('/api/v1/accounts/update_credentials', {
			method: 'PATCH',
			body: { source: { privacy: f.get('privacy'), language: f.get('language'), sensitive: f.has('sensitive') } },
		})
		message('Defaults saved.')
	})
	bind(root.querySelector('#notification-policy'), async (f) => {
		await api('/api/v2/notifications/policy', { method: 'PATCH', body: Object.fromEntries(f) })
		message('Notification policy saved.')
	})
	root.append(
		button('Enable browser notifications', enablePush),
		button('Disable browser notifications', async () => {
			await api('/api/v1/push/subscription', { method: 'DELETE' })
			const reg = await navigator.serviceWorker.ready
			await (await reg.pushManager.getSubscription())?.unsubscribe()
			message('Browser notifications disabled.')
		})
	)
}
async function enablePush() {
	if (!('serviceWorker' in navigator) || !('PushManager' in window))
		throw new Error('This browser does not support push notifications.')
	if ((await Notification.requestPermission()) !== 'granted')
		throw new Error('Notification permission was not granted.')
	const reg = await navigator.serviceWorker.register('/sw.js')
	await navigator.serviceWorker.ready
	const raw = state.instance.configuration.vapid.public_key,
		key = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
		subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
		json = subscription.toJSON()
	await post('/api/v1/push/subscription', {
		subscription: { endpoint: json.endpoint, keys: json.keys },
		data: {
			policy: 'all',
			alerts: {
				follow: true,
				favourite: true,
				reblog: true,
				mention: true,
				poll: true,
				follow_request: true,
				quote: true,
			},
		},
	})
	message('Browser notifications enabled.')
}
async function security(root) {
	const info = await cookie('/api/hyena/security')
	root.innerHTML = `<h2>Account security</h2><p>Two-factor authentication: ${info.two_factor ? 'enabled' : 'disabled'}</p><form id="password"><label>Current password<input type="password" name="password" required autocomplete="current-password"></label><label>New password<input type="password" name="new_password" minlength="12" maxlength="256" required autocomplete="new-password"></label><button>Change password and sign out all sessions</button></form>`
	bind(root.querySelector('form'), async (f) => {
		await cookie('/api/hyena/security/password', 'POST', Object.fromEntries(f))
		location.assign('/login')
	})
	const email = document.createElement('form')
	email.innerHTML = `<h3>Email address</h3><p>Current address: ${esc(info.email || 'None')}</p><label>New email<input type="email" name="email" required autocomplete="email"></label><label>Current password<input name="password" type="password" required autocomplete="current-password"></label><button>Send confirmation</button>`
	bind(email, async (f) => {
		const result = await cookie('/api/hyena/security/email', 'POST', Object.fromEntries(f))
		message(result.message)
		email.reset()
	})
	root.append(email)
	root.append(
		button(info.two_factor ? 'Manage authenticator' : 'Add authenticator', () => totp(info.two_factor, root)),
		button('Add a passkey', () => {
			const d = dialog(
				'Add passkey',
				'<form><label>Name<input name="name" required maxlength="100"></label><label>Current password<input name="password" type="password" required autocomplete="current-password"></label><button>Continue</button></form>'
			)
			bind(d.querySelector('form'), async (f) => {
				const { options, challenge } = await cookie(
						'/api/hyena/security/passkeys/options',
						'POST',
						Object.fromEntries(f)
					),
					response = await credential(options, true)
				await cookie('/api/hyena/security/passkeys/verify', 'POST', { challenge, response })
				d.close()
				await security(root)
			})
		})
	)
	for (const p of info.passkeys) {
		const el = document.createElement('article')
		el.textContent = p.name
		el.append(
			button('Remove passkey', async () => {
				await cookie('/api/hyena/security/passkeys/' + p.id, 'DELETE')
				el.remove()
			})
		)
		root.append(el)
	}
	const h = document.createElement('h3')
	h.textContent = 'Active browser sessions'
	root.append(h)
	for (const s of info.sessions) {
		const el = document.createElement('p')
		el.textContent = 'Expires ' + new Date(s.expires_at).toLocaleString()
		el.append(
			button('Sign out session', async () => {
				await cookie('/api/hyena/security/sessions/' + s.id, 'DELETE')
				el.remove()
			})
		)
		root.append(el)
	}
}
function showCodes(codes) {
	const d = dialog(
		'Save your recovery codes',
		'<p>Each code works once. Keep these somewhere safe; they will not be shown again.</p><pre>' +
			esc(codes.join('\n')) +
			'</pre>'
	)
	d.append(button('Download recovery codes', () => download('hyena-recovery-codes.txt', codes.join('\n'))))
}
function totp(enabled, root) {
	const d = dialog(
		enabled ? 'Manage authenticator' : 'Add authenticator',
		`<form><label>Current password<input type="password" name="password" required autocomplete="current-password"></label>${enabled ? '<label>Authenticator or recovery code<input name="code" required autocomplete="one-time-code"></label><label>Action<select name="action"><option value="recovery_codes">Replace recovery codes</option><option value="totp/disable">Disable authenticator</option></select></label>' : ''}<button>Continue</button></form>`
	)
	bind(d.querySelector('form'), async (f) => {
		if (enabled) {
			const r = await cookie('/api/hyena/security/' + f.get('action'), 'POST', {
				password: f.get('password'),
				code: f.get('code'),
			})
			d.close()
			if (r.recovery_codes) showCodes(r.recovery_codes)
			await security(root)
			return
		}
		const r = await cookie('/api/hyena/security/totp/start', 'POST', { password: f.get('password') })
		d.innerHTML = `<h2>Connect your authenticator</h2><p>Enter this setup key in your authenticator app:</p><code>${esc(r.secret)}</code><p><a href="${esc(r.uri)}">Open authenticator</a></p><form><label>Six-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code"></label><button>Enable</button></form>`
		bind(d.querySelector('form'), async (f) => {
			const result = await cookie('/api/hyena/security/totp/confirm', 'POST', {
				challenge: r.challenge,
				code: f.get('code'),
			})
			d.close()
			showCodes(result.recovery_codes)
			await security(root)
		})
	})
}
async function apps(root) {
	const info = await cookie('/api/hyena/security')
	root.innerHTML = `<h2>Connect a Mastodon app</h2><p>In your app, choose an existing account and enter <strong>${esc(location.host)}</strong> as the server. Sign in on this website and approve the permissions requested by the app.</p><h3>Authorized applications</h3>`
	for (const app of info.applications) {
		const el = document.createElement('article')
		el.innerHTML = `<h3>${esc(app.name)}</h3><p>${esc(app.website || '')}</p>`
		el.append(
			button(
				'Revoke access',
				async () => {
					await cookie('/api/hyena/security/applications/' + app.id, 'DELETE')
					el.remove()
				},
				'danger'
			)
		)
		root.append(el)
	}
}
async function blocks(root) {
	root.replaceChildren()
	const nav = document.createElement('div')
	const list = document.createElement('section')
	for (const [label, path, action] of [
		['Blocked accounts', 'blocks', 'unblock'],
		['Muted accounts', 'mutes', 'unmute'],
	])
		nav.append(
			button(label, async () => {
				list.replaceChildren()
				for (const a of await api('/api/v1/' + path)) {
					const el = person(a)
					el.append(
						button(action === 'unblock' ? 'Unblock' : 'Unmute', async () => {
							await post('/api/v1/accounts/' + a.id + '/' + action)
							el.remove()
						})
					)
					list.append(el)
				}
			})
		)
	nav.append(
		button('Blocked domains', async () => {
			list.innerHTML =
				'<form><label>Domain<input name="domain" required placeholder="example.social"></label><button>Block domain</button></form>'
			bind(list.querySelector('form'), async (f) => {
				await post('/api/v1/domain_blocks', { domain: f.get('domain') })
				await blocks(root)
			})
			for (const domain of await api('/api/v1/domain_blocks')) {
				const el = document.createElement('p')
				el.textContent = domain
				el.append(
					button('Unblock', async () => {
						await api('/api/v1/domain_blocks', { method: 'DELETE', body: { domain } })
						el.remove()
					})
				)
				list.append(el)
			}
		})
	)
	root.append(nav, list)
}
async function filters(root) {
	root.replaceChildren()
	root.append(button('Create filter', () => editFilter(null, root)))
	for (const f of await api('/api/v2/filters')) {
		const el = document.createElement('article')
		el.innerHTML = `<h3>${esc(f.title)}</h3><p>${esc(f.keywords.map((k) => k.keyword).join(', '))} · ${esc(f.filter_action)}</p>`
		el.append(
			button('Edit', () => editFilter(f, root)),
			button(
				'Delete',
				async () => {
					await api('/api/v2/filters/' + f.id, { method: 'DELETE' })
					el.remove()
				},
				'danger'
			)
		)
		root.append(el)
	}
}
function editFilter(filter, root) {
	const d = dialog(
		filter ? 'Edit filter' : 'Create filter',
		`<form><label>Title<input name="title" required value="${esc(filter?.title)}"></label><label>Keywords, one per line<textarea name="keywords" required>${esc(filter?.keywords.map((k) => k.keyword).join('\n'))}</textarea></label><label>Action<select name="action"><option value="warn">Show a warning</option><option value="hide">Hide post</option></select></label>${['home', 'notifications', 'public', 'thread', 'account'].map((k) => box(k, k, filter ? filter.context.includes(k) : true)).join('')}<label>Expire after seconds (blank for never)<input type="number" name="expires" min="60"></label><button>Save filter</button></form>`
	)
	d.querySelector('[name=action]').value = filter?.filter_action ?? 'warn'
	bind(d.querySelector('form'), async (f) => {
		await api('/api/v2/filters' + (filter ? '/' + filter.id : ''), {
			method: filter ? 'PUT' : 'POST',
			body: {
				title: f.get('title'),
				filter_action: f.get('action'),
				context: ['home', 'notifications', 'public', 'thread', 'account'].filter((k) => f.has(k)),
				expires_in: f.get('expires') ? Number(f.get('expires')) : null,
				keywords_attributes: [
					...(filter?.keywords ?? []).map((k) => ({ id: k.id, _destroy: true })),
					...f
						.get('keywords')
						.split('\n')
						.filter(Boolean)
						.map((keyword) => ({ keyword, whole_word: true })),
				],
			},
		})
		d.close()
		await filters(root)
	})
}
async function tags(root) {
	root.innerHTML =
		'<h2>Featured hashtags</h2><form><label>Hashtag<input name="name" required></label><button>Feature on profile</button></form>'
	bind(root.querySelector('form'), async (f) => {
		await post('/api/v1/featured_tags', { name: f.get('name') })
		await tags(root)
	})
	for (const t of await api('/api/v1/featured_tags')) {
		const el = document.createElement('p')
		el.textContent = '#' + t.name
		el.append(
			button('Remove', async () => {
				await api('/api/v1/featured_tags/' + t.id, { method: 'DELETE' })
				el.remove()
			})
		)
		root.append(el)
	}
	const h = document.createElement('h2')
	h.textContent = 'Followed hashtags'
	root.append(h)
	for (const t of await api('/api/v1/followed_tags')) {
		const el = document.createElement('p')
		el.textContent = '#' + t.name
		el.append(
			button('Unfollow', async () => {
				await post('/api/v1/tags/' + t.name + '/unfollow')
				el.remove()
			})
		)
		root.append(el)
	}
}
async function transfers(root) {
	root.innerHTML =
		'<h2>Import and export</h2><p>Download lists as CSV, or import a Mastodon CSV export.</p><div id="csv"></div><form><label>Import type<select name="type">' +
		['following', 'blocks', 'mutes', 'domain_blocks', 'bookmarks', 'lists']
			.map((k) => `<option>${k}</option>`)
			.join('') +
		'</select></label><label>Mode<select name="mode"><option value="merge">Merge with existing</option><option value="overwrite">Replace existing</option></select></label><label>CSV file<input name="file" type="file" accept=".csv,text/csv" required></label><button>Import</button></form><section id="imports"></section><h3>Your account archive</h3><p>Archives include posts and account data. Downloads expire after seven days.</p><section id="exports"></section>'
	for (const type of ['following', 'blocks', 'mutes', 'domain_blocks', 'bookmarks', 'lists']) {
		const a = document.createElement('a')
		a.href = '/api/hyena/export/' + type + '.csv'
		a.textContent = 'Download ' + type
		a.className = 'button'
		root.querySelector('#csv').append(a)
	}
	bind(root.querySelector('form'), async (f) => {
		await cookie('/api/hyena/imports', 'POST', {
			type: f.get('type'),
			mode: f.get('mode'),
			csv: await f.get('file').text(),
		})
		message('Import queued.')
		await transfers(root)
	})
	const imports = await cookie('/api/hyena/imports')
	for (const i of imports) {
		const el = document.createElement('p')
		el.textContent =
			i.type +
			': ' +
			i.status +
			' · ' +
			i.offset +
			' rows processed' +
			(i.errors?.length ? ' · ' + i.errors.length + ' errors' : '')
		if (i.errors?.length)
			el.append(
				button('View errors', () =>
					download('import-errors.json', JSON.stringify(i.errors, null, 2), 'application/json')
				)
			)
		root.querySelector('#imports').append(el)
	}
	root.querySelector('#exports').append(
		button('Request account archive', async () => {
			await cookie('/api/hyena/exports', 'POST', {})
			await transfers(root)
		})
	)
	for (const ex of await cookie('/api/hyena/exports')) {
		const el = document.createElement('article')
		el.textContent = new Date(ex.created_at).toLocaleString() + ' · ' + ex.status
		if (ex.status === 'ready') {
			const a = document.createElement('a')
			a.href = '/api/hyena/exports/' + ex.id + '/archive.tar'
			a.textContent = 'Download archive'
			el.append(a)
		}
		root.querySelector('#exports').append(el)
	}
	const events = await cookie('/api/hyena/severed_relationships')
	if (events.length) {
		const title = document.createElement('h3')
		title.textContent = 'Disconnected relationships'
		root.append(title)
		for (const event of events) {
			const el = document.createElement('article')
			el.textContent = `${event.target_name} · ${new Date(event.created_at).toLocaleString()}`
			for (const direction of ['following', 'followers']) {
				const link = document.createElement('a')
				link.href = `/api/hyena/severed_relationships/${event.id}/${direction}.csv`
				link.textContent = `Download ${event[direction === 'following' ? 'following_count' : 'followers_count']} ${direction}`
				link.className = 'button'
				el.append(link)
			}
			root.append(el)
		}
	}
}
async function account(root) {
	root.innerHTML =
		'<h2>Account</h2><form id="alias"><h3>Moving here from another server?</h3><p>Add your old account as an alias before moving it here.</p><label>Old account<input name="acct" required placeholder="@name@old-server.social"></label><button>Add alias</button></form><form id="move"><h3>Move to another account</h3><p>The destination must already list this account as an alias. Your followers will be asked to follow it.</p><label>Destination<input name="acct" required placeholder="@name@new-server.social"></label><label>Current password<input name="password" type="password" required></label><button>Move account</button></form><form id="delete"><h3>Delete account</h3><p>This deletes your profile and posts and revokes connected applications.</p><label>Confirm your username<input name="username" required></label><label>Current password<input name="password" type="password" required></label><button class="danger">Permanently delete my account</button></form>'
	const logout = document.createElement('form')
	logout.method = 'post'
	logout.action = '/logout'
	logout.innerHTML = `<input type="hidden" name="csrf" value="${esc(state.csrf)}"><button>Sign out</button>`
	root.append(logout)

	bind(root.querySelector('#alias'), async (f) => {
		await cookie('/api/hyena/account/aliases', 'POST', Object.fromEntries(f))
		message('Alias added.')
	})
	bind(root.querySelector('#move'), async (f) => {
		await cookie('/api/hyena/account/move', 'POST', Object.fromEntries(f))
		message('Move requested.')
	})
	bind(root.querySelector('#delete'), async (f) => {
		await cookie('/api/hyena/account/delete', 'POST', Object.fromEntries(f))
		location.assign('/')
	})
}
