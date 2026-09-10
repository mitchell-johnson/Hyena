const form = document.querySelector('#signup')
form.addEventListener('submit', async (event) => {
	event.preventDefault()
	const button = form.querySelector('button'),
		result = document.querySelector('#result')
	button.disabled = true
	try {
		const call = async (path, body, token) => {
			const res = await fetch(path, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
					body: JSON.stringify(body),
				}),
				json = await res.json()
			if (!res.ok) throw new Error(json.error_description || json.error)
			return json
		}
		const app = await call('/api/v1/apps', {
				client_name: 'Hyena signup',
				redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
				scopes: 'write:accounts',
			}),
			token = await call('/oauth/token', {
				grant_type: 'client_credentials',
				client_id: app.client_id,
				client_secret: app.client_secret,
				scope: 'write:accounts',
			}),
			data = new FormData(form)
		await call(
			'/api/v1/accounts',
			{
				username: data.get('username'),
				password: data.get('password'),
				email: data.get('email'),
				agreement: true,
				reason: data.get('reason'),
				invite_code: data.get('invite_code'),
				locale: navigator.language.split('-')[0],
			},
			token.access_token
		)
		form.reset()
		result.textContent =
			'Check your email to confirm your account, then sign in. If this instance requires approval, an administrator will review your request.'
	} catch (error) {
		result.textContent = error.message
	} finally {
		button.disabled = false
	}
})
