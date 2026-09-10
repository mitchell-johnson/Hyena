import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { generateCryptoKeyPair, signRequest, verifyRequest, exportJwk, createFederation } from '@fedify/fedify'
import { Activity, Follow, Create, Delete, Note, Person, CryptographicKey, Flag } from '@fedify/vocab'
import { getDocumentLoader } from '@fedify/vocab-runtime'
import type { InboxContext } from '@fedify/fedify'
import type { Env } from '../src/types'
import { env, runtime, seed, json } from './support'
import { receive } from '../src/federation/receive'
import { actorDocument, federation } from '../src/federation'
import { D1KvStore } from '../src/federation/storage'
import { encryptPush } from '../src/push'
import { animationInfo } from '../src/media/process'
import { expirePoll } from '../src/poll-expiry'
import { one, all } from '../src/data'
const enc = new TextEncoder(),
	decode = new TextDecoder(),
	b64 = (bytes: ArrayBuffer | Uint8Array) =>
		btoa(String.fromCharCode(...new Uint8Array(bytes)))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replace(/=+$/, '')
beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())
it('encrypts a Web Push message a client can decrypt, and detects tampering', async () => {
	const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
			'deriveBits',
		])) as CryptoKeyPair,
		publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
		auth = crypto.getRandomValues(new Uint8Array(16)),
		message = '{"notification_id":"123","body":"Hello 🌍"}',
		payload = await encryptPush(b64(publicKey), b64(auth), message),
		salt = payload.slice(0, 16),
		keyLength = payload[20]!,
		serverKey = payload.slice(21, 21 + keyLength),
		peer = await crypto.subtle.importKey('raw', serverKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []),
		shared = new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'ECDH', public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm,
				pair.privateKey,
				256
			)
		)
	const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))
	const derive = async (secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) =>
		new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'HKDF', hash: 'SHA-256', salt, info },
				await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']),
				length * 8
			)
		)
	const ikm = await derive(shared, auth, concat(enc.encode('WebPush: info\0'), publicKey, serverKey), 32),
		key = await crypto.subtle.importKey(
			'raw',
			await derive(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16),
			'AES-GCM',
			false,
			['decrypt']
		),
		iv = await derive(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12),
		body = payload.slice(21 + keyLength),
		clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body))
	expect(clear.at(-1)).toBe(2)
	expect(decode.decode(clear.slice(0, -1))).toBe(message)
	body[0] = body[0]! ^ 1
	await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body)).rejects.toThrow()
})
it('verifies both HTTP signature standards and rejects a changed activity body', async () => {
	const pair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5'),
		id = new URL('https://remote.example/users/bob#main-key'),
		key = new CryptographicKey({ id, owner: new URL('https://remote.example/users/bob'), publicKey: pair.publicKey }),
		doc = await key.toJsonLd(),
		loader = async (url: string) => ({ contextUrl: null, documentUrl: url, document: doc })
	for (const spec of ['rfc9421', 'draft-cavage-http-signatures-12'] as const) {
		const request = await signRequest(
			new Request(env.PUBLIC_ORIGIN + '/inbox', {
				method: 'POST',
				headers: { 'Content-Type': 'application/activity+json' },
				body: '{"type":"Follow"}',
			}),
			pair.privateKey,
			id,
			{ spec }
		)
		expect(await verifyRequest(request.clone(), { documentLoader: loader, spec })).not.toBeNull()
		const changed = new Request(request, { body: '{"type":"Delete"}' })
		expect(await verifyRequest(changed, { documentLoader: loader, spec })).toBeNull()
	}
})
it('persists verified remote follow/create/delete, rejects forged ownership, and deduplicates repeats', async () => {
	const local = await seed('alice'),
		actor = new Person({
			id: new URL('https://remote.example/users/bob'),
			preferredUsername: 'bob',
			inbox: new URL('https://remote.example/inbox'),
			followers: new URL('https://remote.example/users/bob/followers'),
			discoverable: true,
		}),
		doc = await actor.toJsonLd(),
		localDoc = await actorDocument(env, (await one(env, 'SELECT * FROM accounts WHERE id=?', local.id)) as never),
		f = createFederation<Env>({
			origin: env.PUBLIC_ORIGIN,
			kv: new D1KvStore(env),
			contextLoaderFactory: () => getDocumentLoader(),
			documentLoaderFactory: () => async (url: string) => ({
				contextUrl: null,
				documentUrl: url,
				document: url.startsWith('https://remote.example/') ? doc : localDoc,
			}),
		}),
		ctx = f.createContext(new URL(env.PUBLIC_ORIGIN), env) as InboxContext<Env>,
		follow = new Follow({
			id: new URL('https://remote.example/activities/1'),
			actor: actor.id,
			object: new URL(env.PUBLIC_ORIGIN + '/users/alice'),
		})
	await receive(ctx, follow)
	await receive(ctx, follow)
	expect((await one<{ n: number }>(env, 'SELECT COUNT(*) n FROM follows'))?.n).toBe(1)
	const moderator = await seed('moderator', 'admin')
	await receive(
		ctx,
		new Flag({
			id: new URL('https://remote.example/reports/1'),
			actor: actor.id,
			objects: [new URL(env.PUBLIC_ORIGIN + '/users/alice')],
			summary: 'Remote report',
		})
	)
	const reports = await json<{ report?: { comment: string } }[]>('/api/v1/notifications?types[]=admin.report', {
		token: moderator.token,
	})
	expect(reports[0]?.report?.comment).toBe('Remote report')
	const note = new Note({
			id: new URL('https://remote.example/posts/1'),
			attribution: actor.id,
			content: '<p>hello<script>bad()</script></p>',
			to: new URL('https://www.w3.org/ns/activitystreams#Public'),
		}),
		create = new Create({ id: new URL('https://remote.example/activities/2'), actor: actor.id, object: note })
	await receive(ctx, create)
	const post = await one<{ id: string; content: string }>(
		env,
		'SELECT id,content FROM statuses WHERE uri=?',
		note.id!.href
	)
	expect(post?.content).toBe('<p>hello</p>')
	await expect(
		receive(ctx, new Create({ id: new URL('https://attacker.example/activity'), actor: actor.id, object: note }))
	).rejects.toThrow()
	await receive(
		ctx,
		new Delete({ id: new URL('https://remote.example/activities/3'), actor: actor.id, object: note.id })
	)
	expect(
		(await one<{ deleted_at: string }>(env, 'SELECT deleted_at FROM statuses WHERE id=?', post!.id))?.deleted_at
	).toBeTruthy()
	await receive(ctx, new Create({ id: new URL('https://remote.example/activities/4'), actor: actor.id, object: note }))
	expect(
		(await one<{ deleted_at: string }>(env, 'SELECT deleted_at FROM statuses WHERE id=?', post!.id))?.deleted_at
	).toBeTruthy()
})
it('enforces the duration of an animation and emits poll completion once', async () => {
	const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0))
	expect(animationInfo(gif)).toMatchObject({ frames: 1, pixels: 1 })
	const long = gif.slice(),
		control = long.findIndex((b, i) => b === 0x21 && long[i + 1] === 0xf9)
	new DataView(long.buffer).setUint16(control + 4, 6000, true)
	expect(() => animationInfo(long)).toThrow(/shorter than 60/)
	const a = await seed('alice'),
		b = await seed('bob'),
		s = await json<{ id: string; poll: { id: string } }>('/api/v1/statuses', {
			token: a.token,
			method: 'POST',
			body: { status: 'Vote', poll: { options: ['yes', 'no'], expires_in: 300 } },
		})
	await json('/api/v1/polls/' + s.poll.id + '/votes', { token: b.token, method: 'POST', body: { choices: [0] } })
	await env.DB.prepare('UPDATE polls SET expires_at=? WHERE id=?')
		.bind(new Date(Date.now() - 1000).toISOString(), s.poll.id)
		.run()
	await expirePoll(env, s.poll.id)
	await expirePoll(env, s.poll.id)
	expect(await all(env, "SELECT id FROM notifications WHERE type='poll'")).toHaveLength(2)
})

it('retains the collection consent extension through actor JSON-LD decoding', async () => {
	const a = await seed('alice')
	const doc = await actorDocument(env, (await one(env, 'SELECT * FROM accounts WHERE id=?', a.id)) as never)
	const decoded = await Person.fromJsonLd(doc)
	const encoded = (await decoded.toJsonLd()) as Record<string, unknown>
	expect(encoded.interactionPolicy).toEqual(doc.interactionPolicy)
	expect(encoded.featuredCollections).toEqual(doc.featuredCollections)
})
