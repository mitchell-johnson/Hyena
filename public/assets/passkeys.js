const decode = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
const encode = (b) =>
	btoa(String.fromCharCode(...new Uint8Array(b)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
export async function credential(options, register = false) {
	const publicKey = { ...options, challenge: decode(options.challenge) }
	if (register) {
		publicKey.user = { ...options.user, id: decode(options.user.id) }
		publicKey.excludeCredentials = options.excludeCredentials?.map((c) => ({ ...c, id: decode(c.id) }))
	} else publicKey.allowCredentials = options.allowCredentials?.map((c) => ({ ...c, id: decode(c.id) }))
	const c = await navigator.credentials[register ? 'create' : 'get']({ publicKey })
	if (!c) throw new Error('Passkey operation was cancelled')
	const response = { clientDataJSON: encode(c.response.clientDataJSON) }
	if (register) {
		response.attestationObject = encode(c.response.attestationObject)
		response.transports = c.response.getTransports?.() ?? []
	} else {
		response.authenticatorData = encode(c.response.authenticatorData)
		response.signature = encode(c.response.signature)
		response.userHandle = c.response.userHandle ? encode(c.response.userHandle) : null
	}
	return {
		id: c.id,
		rawId: encode(c.rawId),
		type: c.type,
		authenticatorAttachment: c.authenticatorAttachment,
		response,
		clientExtensionResults: c.getClientExtensionResults(),
	}
}
