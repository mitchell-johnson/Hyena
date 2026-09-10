import { generateCryptoKeyPair, importJwk, exportJwk } from '@fedify/fedify'
import type { Env } from '../types'
import { accountById, one, run } from '../data'
import { ApiError } from '../http'

const encode = (data: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(data)))
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
async function encryptionKey(env: Env) {
	const secret =
		env.KEY_ENCRYPTION_SECRET ??
		(/^https?:\/\/(localhost|127\.0\.0\.1|hyena\.test)(:|$)/.test(env.PUBLIC_ORIGIN) ? env.SETUP_TOKEN : undefined)
	if (!secret) throw new ApiError(503, 'Configure KEY_ENCRYPTION_SECRET before federation')
	return crypto.subtle.importKey(
		'raw',
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)),
		'AES-GCM',
		false,
		['encrypt', 'decrypt']
	)
}
export async function seal(env: Env, value: unknown) {
	const iv = crypto.getRandomValues(new Uint8Array(12))
	return JSON.stringify({
		iv: encode(iv),
		data: encode(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				await encryptionKey(env),
				new TextEncoder().encode(JSON.stringify(value))
			)
		),
	})
}
export async function unseal<T>(env: Env, value: string): Promise<T> {
	const data = JSON.parse(value) as { iv: string; data: string }
	return JSON.parse(
		new TextDecoder().decode(
			await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(data.iv) }, await encryptionKey(env), decode(data.data))
		)
	) as T
}
export async function actorKeys(env: Env, id: string): Promise<CryptoKeyPair[]> {
	const a = await accountById(env, id)
	if (a.domain) return []
	let encrypted = a.private_keys
	if (!encrypted) {
		const pairs = await Promise.all([generateCryptoKeyPair('RSASSA-PKCS1-v1_5'), generateCryptoKeyPair('Ed25519')])
		const exported = await Promise.all(
			pairs.map(async (p) => ({ private: await exportJwk(p.privateKey), public: await exportJwk(p.publicKey) }))
		)
		await run(
			env,
			'UPDATE accounts SET private_keys=?,public_keys=? WHERE id=? AND private_keys IS NULL',
			await seal(env, exported),
			JSON.stringify(exported.map((p) => p.public)),
			id
		)
		encrypted = (await one<{ private_keys: string }>(env, 'SELECT private_keys FROM accounts WHERE id=?', id))!
			.private_keys
	}
	const pairs = await unseal<{ private: JsonWebKey; public: JsonWebKey }[]>(env, encrypted)
	return Promise.all(
		pairs.map(async (p) => ({
			privateKey: await importJwk(p.private, 'private'),
			publicKey: await importJwk(p.public, 'public'),
		}))
	)
}
