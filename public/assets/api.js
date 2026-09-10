export const state = { token: null, csrf: null, account: null, instance: null, next: null }
export const esc = (value) =>
	String(value ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	)
export function message(value, error = false) {
	const modal = [...document.querySelectorAll('dialog[open]')].at(-1)
	let node = modal ? modal.querySelector('.dialog-message') : document.querySelector('#message')
	if (modal && !node && value) {
		node = document.createElement('p')
		node.className = 'dialog-message'
		const heading = modal.querySelector('h2')
		if (heading) heading.after(node)
		else modal.prepend(node)
	}
	if (node) {
		node.setAttribute('role', error ? 'alert' : 'status')
		node.setAttribute('aria-live', error ? 'assertive' : 'polite')
		node.textContent = value
		node.classList.toggle('error', error)
	} else if (value) window.alert(value)
}
export async function api(path, { method = 'GET', body, headers = {}, cookie = false } = {}) {
	const url = new URL(path, location.origin)
	if (url.origin !== location.origin) throw new Error('Refusing a cross-origin API request')
	const res = await fetch(url, {
		method,
		credentials: 'same-origin',
		headers: {
			...(state.token && !cookie ? { Authorization: 'Bearer ' + state.token } : {}),
			...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
			...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}),
			...headers,
		},
		body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
	})
	if (!res.ok) {
		let error
		try {
			error = await res.json()
		} catch {}
		throw new Error(error?.error_description || error?.error || 'Request failed (' + res.status + ')')
	}
	const next = /<([^>]+)>; rel="next"/.exec(res.headers.get('Link') ?? '')
	state.next = next?.[1] ?? null
	if ([204, 206].includes(res.status) || res.headers.get('Content-Length') === '0') return null
	const text = await res.text()
	return text ? JSON.parse(text) : null
}
export const post = (path, body = {}) => api(path, { method: 'POST', body })
export function bind(form, fn) {
	form.addEventListener('submit', async (event) => {
		event.preventDefault()
		form.closest('dialog')?.querySelector('.dialog-message')?.remove()
		const button = form.querySelector('button[type=submit],button:not([type])')
		if (button) button.disabled = true
		try {
			await fn(new FormData(form), form)
		} catch (error) {
			message(error.message, true)
		} finally {
			if (button) button.disabled = false
		}
	})
}
export function button(label, fn, className = '') {
	const el = document.createElement('button')
	el.textContent = label
	el.type = 'button'
	el.className = className
	el.addEventListener('click', async () => {
		el.disabled = true
		try {
			await fn(el)
		} catch (error) {
			message(error.message, true)
		} finally {
			el.disabled = false
		}
	})
	return el
}
export function dialog(title, html) {
	const el = document.createElement('dialog')
	el.innerHTML = `<h2>${esc(title)}</h2>${html}`
	el.append(
		button(
			'Close',
			() => {
				el.close()
				el.remove()
			},
			'quiet'
		)
	)
	document.body.append(el)
	el.showModal()
	el.addEventListener('close', () => el.remove())
	return el
}
export async function resolveAccount(value) {
	const result = await api('/api/v2/search?type=accounts&resolve=true&q=' + encodeURIComponent(value))
	if (!result.accounts?.[0]) throw new Error('Account not found')
	return result.accounts[0]
}
export function download(name, text, type = 'text/plain') {
	const url = URL.createObjectURL(new Blob([text], { type })),
		a = document.createElement('a')
	a.href = url
	a.download = name
	a.click()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
