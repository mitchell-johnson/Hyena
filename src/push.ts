import { Hono } from 'hono'
import { validatePublicUrl } from '@fedify/vocab-runtime'
import { authenticate } from './auth/access'
import { all, one, run, parsed, object, now } from './data'
import { nextId } from './db'
import { ApiError, boolField, readInput, stringField } from './http'
import { seal, unseal } from './federation/keys'
import { notificationJSON, notificationTable, notificationTypes, type NotificationRow } from './notifications'
import { blocked } from './policy'
import type { AppEnv, Env } from './types'

export const push = new Hono<AppEnv>()
const b64 = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
const bytes = (s: string) => {
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw new ApiError(422, 'Invalid push key encoding')
	try {
		return Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
	} catch {
		throw new ApiError(422, 'Invalid push key')
	}
}
const concat = (...parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let offset = 0
	for (const p of parts) {
		result.set(p, offset)
		offset += p.length
	}
	return result
}
const utf8 = (s: string) => new TextEncoder().encode(s)
type Vapid = { public: string; private: JsonWebKey }
export async function vapid(env: Env): Promise<Vapid> {
	if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
		const raw = bytes(env.VAPID_PUBLIC_KEY)
		if (raw.length !== 65) throw new ApiError(503, 'Invalid VAPID public key')
		return {
			public: env.VAPID_PUBLIC_KEY,
			private: {
				kty: 'EC',
				crv: 'P-256',
				x: b64(raw.slice(1, 33)),
				y: b64(raw.slice(33)),
				d: env.VAPID_PRIVATE_KEY,
				ext: true,
			},
		}
	}
	let row = await one<{ value: string }>(env, "SELECT value FROM settings WHERE key='vapid'")
	if (!row) {
		const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
				'sign',
				'verify',
			])) as CryptoKeyPair,
			value = {
				public: b64((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
				private: await crypto.subtle.exportKey('jwk', pair.privateKey),
			}
		await run(env, "INSERT OR IGNORE INTO settings(key,value) VALUES('vapid',?)", await seal(env, value))
		row = await one<{ value: string }>(env, "SELECT value FROM settings WHERE key='vapid'")
	}
	return unseal<Vapid>(env, row!.value)
}
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt, info },
			await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
			length * 8
		)
	)
}
// RFC 8291 / RFC 8188, one final aes128gcm record. This uses only Workers'
// Web Crypto implementation, with no Node HTTP transport or external service.
export async function encryptPush(p256dh: string, auth: string, payload: string) {
	const receiver = bytes(p256dh),
		authentication = bytes(auth)
	if (receiver.length !== 65 || authentication.length !== 16) throw new ApiError(422, 'Invalid push subscription keys')
	const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
			'deriveBits',
		])) as CryptoKeyPair,
		publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
		peer = await crypto.subtle.importKey('raw', receiver, { name: 'ECDH', namedCurve: 'P-256' }, false, []),
		shared = new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'ECDH', public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm,
				pair.privateKey,
				256
			)
		)
	const salt = crypto.getRandomValues(new Uint8Array(16)),
		ikm = await hkdf(shared, authentication, concat(utf8('WebPush: info\0'), receiver, publicKey), 32),
		cek = await hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16),
		nonce = await hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12),
		plain = concat(utf8(payload), new Uint8Array([2]))
	if (plain.length > 3993) throw new ApiError(422, 'Push payload too large')
	const encrypted = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce },
			await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']),
			plain
		),
		header = new Uint8Array(5)
	new DataView(header.buffer).setUint32(0, 4096)
	header[4] = publicKey.length
	return concat(salt, header, publicKey, new Uint8Array(encrypted))
}
interface Subscription {
	id: string
	token_hash: string
	account_id: string
	endpoint: string
	p256dh: string
	auth: string
	alerts: string
	policy: string
	token_cipher: string | null
}
async function subscriptionJSON(env: Env, s: Subscription) {
	return {
		id: s.id,
		endpoint: s.endpoint,
		server_key: (await vapid(env)).public,
		alerts: parsed<Record<string, boolean>>(s.alerts, {}),
		policy: s.policy,
		standard: true,
	}
}
push.get('/api/v1/push/subscription', async (c) => {
	await authenticate(c, 'push')
	const s = await one<Subscription>(
		c.env,
		'SELECT * FROM push_subscriptions WHERE token_hash=?',
		c.get('token').token_hash
	)
	if (!s) throw new ApiError(404, 'Record not found')
	return c.json(await subscriptionJSON(c.env, s))
})
push.post('/api/v1/push/subscription', async (c) => {
	await authenticate(c, 'push')
	const input = await readInput(c.req.raw),
		sub = object(input.subscription),
		keys = object(sub.keys),
		data = input.data === undefined ? {} : object(input.data),
		endpoint = stringField(sub, 'endpoint'),
		p256dh = stringField(keys, 'p256dh'),
		auth = stringField(keys, 'auth'),
		policy = stringField(data, 'policy', 'all'),
		alertsInput = data.alerts === undefined ? {} : object(data.alerts),
		alerts: Record<string, boolean> = {}
	let url: URL
	try {
		url = new URL(endpoint)
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.port ||
			endpoint.length > 2048 ||
			/^(localhost|.*\.localhost|.*\.local)$/.test(url.hostname) ||
			/^\[|^[\d.]+$/.test(url.hostname)
		)
			throw 0
	} catch {
		throw new ApiError(422, 'Invalid push endpoint')
	}
	// Validate the supplied ECDH public key before saving an unusable subscription.
	if (
		bytes(auth).length !== 16 ||
		bytes(p256dh).length !== 65 ||
		!['all', 'followed', 'follower', 'none'].includes(policy)
	)
		throw new ApiError(422, 'Invalid push settings')
	try {
		await crypto.subtle.importKey('raw', bytes(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
	} catch {
		throw new ApiError(422, 'Invalid push public key')
	}
	for (const type of notificationTypes) alerts[type] = boolField(alertsInput, type, false)
	const id = await nextId(c.env.DB),
		token = c.get('token')
	await run(
		c.env,
		'INSERT INTO push_subscriptions(id,token_hash,account_id,endpoint,p256dh,auth,alerts,policy,created_at,token_cipher) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,alerts=excluded.alerts,policy=excluded.policy,token_cipher=excluded.token_cipher',
		id,
		token.token_hash,
		token.account_id!,
		endpoint,
		p256dh,
		auth,
		JSON.stringify(alerts),
		policy,
		now(),
		await seal(c.env, c.req.header('Authorization')!.replace(/^Bearer /i, ''))
	)
	return c.json(
		await subscriptionJSON(
			c.env,
			(await one<Subscription>(c.env, 'SELECT * FROM push_subscriptions WHERE token_hash=?', token.token_hash))!
		)
	)
})
push.put('/api/v1/push/subscription', async (c) => {
	await authenticate(c, 'push')
	const s = await one<Subscription>(
		c.env,
		'SELECT * FROM push_subscriptions WHERE token_hash=?',
		c.get('token').token_hash
	)
	if (!s) throw new ApiError(404, 'Record not found')
	const input = await readInput(c.req.raw),
		data = object(input.data),
		alerts = parsed<Record<string, boolean>>(s.alerts, {}),
		change = data.alerts === undefined ? {} : object(data.alerts),
		policy = stringField(data, 'policy', s.policy)
	if (!['all', 'followed', 'follower', 'none'].includes(policy)) throw new ApiError(422, 'Invalid push policy')
	for (const type of notificationTypes) if (type in change) alerts[type] = boolField(change, type)
	await run(c.env, 'UPDATE push_subscriptions SET alerts=?,policy=? WHERE id=?', JSON.stringify(alerts), policy, s.id)
	return c.json(await subscriptionJSON(c.env, { ...s, alerts: JSON.stringify(alerts), policy }))
})
push.delete('/api/v1/push/subscription', async (c) => {
	await authenticate(c, 'push')
	await run(c.env, 'DELETE FROM push_subscriptions WHERE token_hash=?', c.get('token').token_hash)
	return c.json({})
})
export async function deliverPush(env: Env, notificationId: string) {
	const n = await one<NotificationRow>(
		env,
		`SELECT * FROM ${notificationTable} notifications WHERE id=? AND dismissed=0 AND request=0`,
		notificationId
	)
	if (!n || (await blocked(env, n.account_id, n.from_account_id))) return
	const payload = await notificationJSON(env, n)
	await env.STREAMS.get(env.STREAMS.idFromName(n.account_id)).sendEvent('notification', JSON.stringify(payload), [
		'user',
		'user:notification',
	])
	const subscriptions = await all<Subscription>(
		env,
		`SELECT s.* FROM push_subscriptions s JOIN oauth_tokens t ON t.token_hash=s.token_hash WHERE s.account_id=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>unixepoch('subsec')*1000)`,
		n.account_id
	)
	for (const s of subscriptions) {
		if (!parsed<Record<string, boolean>>(s.alerts, {})[n.type] || s.policy === 'none') continue
		if (
			s.policy === 'followed' &&
			!(await one(
				env,
				"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
				n.account_id,
				n.from_account_id
			))
		)
			continue
		if (
			s.policy === 'follower' &&
			!(await one(
				env,
				"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
				n.from_account_id,
				n.account_id
			))
		)
			continue
		if (
			await one(
				env,
				'SELECT 1 FROM delivery_receipts WHERE activity_id=? AND inbox=?',
				'push:' + notificationId,
				s.endpoint
			)
		)
			continue
		const key = await vapid(env),
			header = b64(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))),
			claims = b64(
				utf8(
					JSON.stringify({
						aud: new URL(s.endpoint).origin,
						exp: Math.floor(Date.now() / 1000) + 43200,
						sub: env.VAPID_SUBJECT || 'mailto:' + (env.CONTACT_EMAIL || 'admin@' + new URL(env.PUBLIC_ORIGIN).hostname),
					})
				)
			),
			unsigned = header + '.' + claims,
			signature = b64(
				await crypto.subtle.sign(
					{ name: 'ECDSA', hash: 'SHA-256' },
					await crypto.subtle.importKey('jwk', key.private, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
					utf8(unsigned)
				)
			)
		const body = await encryptPush(
			s.p256dh,
			s.auth,
			JSON.stringify({
				access_token: s.token_cipher ? await unseal<string>(env, s.token_cipher) : undefined,
				notification_id: n.id,
				notification_type: n.type,
				preferred_locale: 'en',
				title: (payload.account?.display_name || payload.account?.username || 'Hyena') + ' · ' + n.type,
				body:
					typeof payload.status?.content === 'string'
						? payload.status.content.replace(/<[^>]+>/g, '').slice(0, 300)
						: '',
				icon: payload.account?.avatar ?? env.PUBLIC_ORIGIN + '/avatar.svg',
			})
		)
		await validatePublicUrl(s.endpoint)
		const response = await fetch(s.endpoint, {
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(15000),
			headers: {
				Authorization: `vapid t=${unsigned}.${signature}, k=${key.public}`,
				'Content-Encoding': 'aes128gcm',
				'Content-Type': 'application/octet-stream',
				TTL: '86400',
				Urgency: 'normal',
			},
			body,
		})
		await response.body?.cancel()
		if (response.status === 404 || response.status === 410)
			await run(env, 'DELETE FROM push_subscriptions WHERE id=?', s.id)
		else if (!response.ok) throw new Error('Push service rejected delivery')
		else
			await run(
				env,
				'INSERT OR IGNORE INTO delivery_receipts VALUES(?,?,?)',
				'push:' + notificationId,
				s.endpoint,
				now()
			)
	}
}
