import { argon2id } from '@noble/hashes/argon2.js'

export function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}
export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)))
}
export async function digest(value: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}
export function equal(a: string, b: string): boolean {
	let difference = a.length ^ b.length
	for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
	return difference === 0
}
export function passwordHash(password: string, salt = randomToken()): string {
	const hash = argon2id(password, salt, { m: 19456, t: 2, p: 1, dkLen: 32, maxmem: 32 * 1024 * 1024 })
	return `argon2id:v1:${salt}:${base64url(hash)}`
}
export function verifyPassword(password: string, encoded: string): boolean {
	const [algorithm, version, salt, hash] = encoded.split(':')
	if (algorithm !== 'argon2id' || version !== 'v1' || !salt || !hash) return false
	return equal(passwordHash(password, salt), encoded)
}
