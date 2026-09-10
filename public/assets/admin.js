import { state, esc, api, post, bind, button, dialog, message } from './api.js'
import { person, status } from './render.js'
export async function administration(root) {
	root.replaceChildren()
	const nav = document.createElement('div')
	nav.className = 'tabs'
	const content = document.createElement('section')
	for (const [name, fn] of Object.entries({
		Overview: overview,
		Accounts: accounts,
		Reports: reports,
		'Server rules': rules,
		Announcements: announcements,
		Emojis: emojis,
		Trends: trends,
		'Federation rules': federation,
		Settings: settings,
		Invites: invites,
	}))
		nav.append(button(name, () => fn(content), 'quiet'))
	root.append(nav, content)
	await overview(content)
}
async function overview(root) {
	const health = await api('/api/hyena/admin/health')
	const states = { done: 'Completed', pending: 'Waiting', queued: 'Queued', processing: 'Running', dead: 'Failed' }
	root.innerHTML = `<h2>Instance health</h2><p>Hyena ${esc(health.version)}</p><table><caption>Background work</caption><thead><tr><th>Type</th><th>State</th><th>Jobs</th></tr></thead><tbody>${health.jobs.map((j) => `<tr><td>${esc(j.kind)}</td><td>${esc(states[j.state] || j.state)}</td><td>${j.count}</td></tr>`).join('')}</tbody></table><h3>Jobs needing attention</h3>`
	const jobs = await api('/api/hyena/admin/jobs')
	if (!jobs.length) root.insertAdjacentHTML('beforeend', '<p>No failed jobs or retries waiting.</p>')
	for (const job of jobs) {
		const el = document.createElement('article')
		const state =
			job.state === 'dead' ? 'Failed' : job.state === 'processing' ? 'Retry running' : 'Automatic retry pending'
		el.innerHTML = `<p>${esc(job.kind)} · ${state} · Attempts: ${job.attempt}</p><p>${esc(job.last_error)}</p>`
		if (job.state === 'pending')
			el.insertAdjacentHTML('beforeend', `<p>Next attempt: ${esc(new Date(job.available_at).toLocaleString())}</p>`)
		if (job.state === 'dead')
			el.append(
				button('Retry', async () => {
					await post('/api/hyena/admin/jobs/' + encodeURIComponent(job.id) + '/retry')
					await overview(root)
				})
			)
		root.append(el)
	}
	const end = new Date(),
		start = new Date(Date.now() - 7 * 86400000),
		measures = await post('/api/v1/admin/measures', {
			keys: ['active_users', 'new_users', 'interactions', 'opened_reports'],
			start_at: start.toISOString(),
			end_at: end.toISOString(),
		})
	const stats = document.createElement('section')
	stats.innerHTML =
		'<h3>Past seven days</h3>' +
		measures.map((m) => `<p>${esc(m.key.replaceAll('_', ' '))}: <strong>${esc(m.total)}</strong></p>`).join('')
	root.append(stats)
}
async function accounts(root) {
	root.innerHTML =
		'<h2>Accounts</h2><form><label>Search username<input name="username"></label><label>Status<select name="status"><option value="">All</option><option value="pending">Pending approval</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label><button>Search</button></form><section id="accounts"></section>'
	const load = async (params = '') => {
		const list = root.querySelector('#accounts')
		list.replaceChildren()
		for (const row of await api('/api/v2/admin/accounts?' + params)) {
			const a = row.account,
				el = person(a)
			el.insertAdjacentHTML(
				'beforeend',
				`<p>${esc(row.email || 'Remote account')} · ${row.approved ? 'Approved' : 'Pending'}</p>`
			)
			for (const action of row.approved ? ['enable', 'unsilence', 'unsuspend'] : ['approve', 'reject'])
				el.append(
					button(action, async () => {
						await post('/api/v1/admin/accounts/' + row.id + '/' + action)
						message('Account updated.')
					})
				)
			el.append(
				button('Moderate account', () => {
					const d = dialog(
						'Moderate @' + a.acct,
						'<form><label>Action<select name="type"><option value="none">Warning</option><option value="disable">Disable login</option><option value="silence">Limit visibility</option><option value="suspend">Suspend</option></select></label><label>Reason<textarea name="text" required></textarea></label><button class="danger">Apply action</button></form>'
					)
					bind(d.querySelector('form'), async (f) => {
						await post('/api/v1/admin/accounts/' + row.id + '/action', Object.fromEntries(f))
						d.close()
						message('Moderation action recorded.')
					})
				})
			)
			list.append(el)
		}
	}
	bind(root.querySelector('form'), async (f) => load(new URLSearchParams(f).toString()))
	await load()
}
async function reports(root) {
	root.innerHTML = '<h2>Reports</h2>'
	for (const r of await api('/api/v1/admin/reports?resolved=false')) {
		const el = document.createElement('article')
		el.innerHTML = `<h3>Report #${esc(r.id)} · ${esc(r.category)}</h3><p>${esc(r.comment)}</p><p>Reported: @${esc(r.target_account?.account?.acct || r.target_account?.acct)}</p>`
		for (const s of r.statuses ?? []) el.append(status(s))
		for (const action of ['assign_to_self', 'unassign', 'resolve', 'reopen'])
			el.append(
				button(action.replaceAll('_', ' '), async () => {
					await post('/api/v1/admin/reports/' + r.id + '/' + action)
					if (action === 'resolve') el.remove()
					else message('Report updated.')
				})
			)
		root.append(el)
	}
}
async function rules(root) {
	const rules = await api('/api/v1/instance/rules')
	root.innerHTML =
		'<h2>Server rules</h2><form><label>One rule per line<textarea name="rules" rows="12">' +
		esc(rules.map((r) => r.text).join('\n')) +
		'</textarea></label><button>Save rules</button></form>'
	bind(root.querySelector('form'), async (f) => {
		await api('/api/hyena/admin/rules', {
			method: 'PUT',
			body: {
				rules: f
					.get('rules')
					.split('\n')
					.filter(Boolean)
					.map((text) => ({ text, hint: '' })),
			},
		})
		message('Rules saved.')
	})
}
async function announcements(root) {
	root.innerHTML =
		'<h2>Announcements</h2><form><label>Announcement<textarea name="content" required maxlength="10000"></textarea></label><label>Starts at<input type="datetime-local" name="starts_at"></label><label>Ends at<input type="datetime-local" name="ends_at"></label><button>Publish announcement</button></form>'
	bind(root.querySelector('form'), async (f) => {
		await post('/api/hyena/admin/announcements', {
			content: f.get('content'),
			starts_at: f.get('starts_at') ? new Date(f.get('starts_at')).toISOString() : '',
			ends_at: f.get('ends_at') ? new Date(f.get('ends_at')).toISOString() : '',
		})
		await announcements(root)
	})
	for (const a of await api('/api/v1/announcements')) {
		const el = document.createElement('article')
		el.innerHTML = a.content
		el.append(
			button(
				'Delete announcement',
				async () => {
					await api('/api/hyena/admin/announcements/' + a.id, { method: 'DELETE' })
					el.remove()
				},
				'danger'
			)
		)
		root.append(el)
	}
}
async function emojis(root) {
	root.innerHTML =
		'<h2>Custom emoji</h2><form><label>Shortcode<input name="shortcode" pattern="[a-zA-Z0-9_]+" required></label><label>Category<input name="category"></label><label>Image<input name="file" type="file" accept="image/png,image/webp,image/gif" required></label><button>Upload emoji</button></form>'
	bind(root.querySelector('form'), async (f) => {
		const body = new FormData()
		body.set('file', f.get('file'))
		const m = await api('/api/v1/media', { method: 'POST', body })
		await post('/api/hyena/admin/custom_emojis', {
			shortcode: f.get('shortcode'),
			category: f.get('category'),
			media_id: m.id,
		})
		await emojis(root)
	})
	for (const e of await api('/api/v1/custom_emojis')) {
		const el = document.createElement('article')
		el.innerHTML = `<img src="${esc(e.url)}" width="32" height="32" alt=""> :${esc(e.shortcode)}:`
		el.append(
			button('Remove', async () => {
				await api('/api/hyena/admin/custom_emojis/' + e.shortcode, { method: 'DELETE' })
				el.remove()
			})
		)
		root.append(el)
	}
}
async function trends(root) {
	root.replaceChildren()
	const nav = document.createElement('div'),
		list = document.createElement('section')
	for (const kind of ['tags', 'statuses', 'links'])
		nav.append(
			button(kind, async () => {
				list.replaceChildren()
				for (const row of await api('/api/v1/admin/trends/' + kind)) {
					const el = document.createElement('article')
					if (kind === 'statuses') el.append(status(row))
					else el.innerHTML = `<h3>${esc(row.name || row.title)}</h3><p>${esc(row.url)}</p>`
					for (const action of ['approve', 'reject'])
						el.append(
							button(action, async () => {
								await post('/api/v1/admin/trends/' + kind + '/' + encodeURIComponent(row.id || row.name) + '/' + action)
								el.remove()
							})
						)
					list.append(el)
				}
			})
		)
	root.append(nav, list)
}
async function federation(root) {
	root.replaceChildren()
	const nav = document.createElement('div'),
		list = document.createElement('section')
	for (const kind of ['domain_blocks', 'domain_allows', 'email_domain_blocks', 'ip_blocks', 'canonical_email_blocks'])
		nav.append(
			button(kind.replaceAll('_', ' '), async () => {
				const key = kind === 'ip_blocks' ? 'ip' : kind === 'canonical_email_blocks' ? 'email' : 'domain'
				list.innerHTML = `<h2>${esc(kind.replaceAll('_', ' '))}</h2><form><label>${key}<input name="${key}" required></label>${kind === 'domain_blocks' ? '<label>Action<select name="severity"><option value="suspend">Suspend federation</option><option value="silence">Limit visibility</option><option value="noop">Media or report rules only</option></select></label><label><input type="checkbox" name="reject_media"> Reject media</label><label><input type="checkbox" name="reject_reports"> Reject reports</label>' : kind === 'ip_blocks' ? '<label>Action<select name="severity"><option value="no_access">Block access</option><option value="sign_up_block">Block registration</option><option value="sign_up_requires_approval">Require approval</option></select></label><label>Expires after seconds<input name="expires_in" type="number" min="60" value="86400"></label>' : ''}<label>Private comment<textarea name="private_comment"></textarea></label><button>Add rule</button></form>`
				bind(list.querySelector('form'), async (f) => {
					const body = Object.fromEntries(f)
					for (const k of ['reject_media', 'reject_reports']) body[k] = f.has(k)
					await post('/api/v1/admin/' + kind, body)
					message('Rule added.')
					await federation(root)
				})
				for (const r of await api('/api/v1/admin/' + kind)) {
					const el = document.createElement('article')
					el.innerHTML = `<strong>${esc(r.domain || r.ip || r.canonical_email_hash)}</strong><p>${esc(r.severity || '')}</p>`
					el.append(
						button('Remove rule', async () => {
							await api('/api/v1/admin/' + kind + '/' + r.id, { method: 'DELETE' })
							el.remove()
						})
					)
					list.append(el)
				}
			})
		)
	root.append(nav, list)
}
async function settings(root) {
	const s = await api('/api/hyena/admin/settings')
	root.innerHTML = `<form><h2>Instance settings</h2>${[
		['extended_description', 'About this instance'],
		['privacy_policy', 'Privacy policy'],
		['terms_of_service', 'Terms of service'],
	]
		.map(([k, t]) => `<label>${t}<textarea name="${k}" rows="6">${esc(s[k] || '')}</textarea></label>`)
		.join(
			''
		)}<label>Languages, comma separated<input name="languages" value="${esc((s.languages ?? ['en']).join(','))}"></label><label><input name="limited_federation" type="checkbox" ${s.limited_federation ? 'checked' : ''}> Federate only with allowed domains</label><label><input name="wrapstodon" type="checkbox" ${s.wrapstodon ? 'checked' : ''}> Enable annual reports during the December campaign</label><h3>Monthly media limits</h3><p>Processing stops at these limits. Raising a limit can increase your Cloudflare bill.</p>${[
		['monthly_media_bytes', 'Uploaded bytes', 1073741824],
		['monthly_image_transforms', 'Image transformations', 5000],
		['monthly_media_seconds', 'Video processing seconds', 5000],
		['max_accounts', 'Maximum local accounts', 10],
	]
		.map(
			([k, t, v]) =>
				`<label>${t}<input name="${k}" type="number" min="0" step="1" required value="${s[k] ?? v}"></label>`
		)
		.join('')}<button>Save settings</button></form>`
	bind(root.querySelector('form'), async (f) => {
		const body = Object.fromEntries(f)
		body.languages = body.languages
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
		for (const k of ['wrapstodon', 'limited_federation']) body[k] = f.has(k)
		for (const k of ['monthly_media_bytes', 'monthly_image_transforms', 'monthly_media_seconds', 'max_accounts'])
			body[k] = Number(body[k])
		await api('/api/hyena/admin/settings', { method: 'PUT', body })
		message('Instance settings saved.')
	})
}
async function invites(root) {
	root.innerHTML =
		'<h2>Invite someone</h2><form><label>Maximum uses<input name="max_uses" type="number" min="1" max="100" value="1" required></label><label>Expires in<select name="expires_in"><option value="86400">One day</option><option value="604800">One week</option><option value="2592000">One month</option></select></label><button>Create invitation</button></form>'
	bind(root.querySelector('form'), async (f) => {
		const result = await api('/api/hyena/invites', {
			method: 'POST',
			cookie: true,
			body: { max_uses: Number(f.get('max_uses')), expires_in: Number(f.get('expires_in')) },
		})
		const d = dialog('Invitation created', '<p>Share this link with your invitee:</p>')
		const input = document.createElement('input')
		input.readOnly = true
		input.value = result.url
		d.append(input)
		input.select()
	})
}
