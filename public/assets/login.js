const passkey = document.querySelector('#passkey-login')
if (passkey)
	passkey.addEventListener('click', async () => {
		passkey.disabled = true
		try {
			const { credential } = await import('./passkeys.js')
			const call = async (path, body) => {
				const res = await fetch(path, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
						credentials: 'same-origin',
					}),
					json = await res.json()
				if (!res.ok) throw new Error(json.error)
				return json
			}
			const { options } = await call('/api/hyena/passkeys/options', {}),
				response = await credential(options),
				result = await call('/api/hyena/passkeys/verify', { response })
			location.assign(result.redirect)
		} catch (error) {
			const el = document.querySelector('#passkey-error') ?? document.createElement('p')
			el.id = 'passkey-error'
			el.setAttribute('role', 'alert')
			el.textContent = error.message
			passkey.after(el)
		} finally {
			passkey.disabled = false
		}
	})
