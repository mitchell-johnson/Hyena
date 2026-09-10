import type {
	KvKey,
	KvStore,
	KvStoreSetOptions,
	MessageQueue,
	MessageQueueEnqueueOptions,
	MessageQueueListenOptions,
} from '@fedify/fedify'
import { seal } from './keys'
import { digest } from '../auth/crypto'
import type { Env } from '../types'
import { all, one, run } from '../data'

export class D1KvStore implements KvStore {
	constructor(private env: Env) {}
	async get<T>(key: KvKey): Promise<T | undefined> {
		const r = await one<{ value: string }>(
			this.env,
			'SELECT value FROM federation_kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)',
			JSON.stringify(key),
			Date.now()
		)
		return r ? (JSON.parse(r.value) as T) : undefined
	}
	async set(key: KvKey, value: unknown, options?: KvStoreSetOptions) {
		await run(
			this.env,
			'INSERT INTO federation_kv(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at',
			JSON.stringify(key),
			JSON.stringify(value),
			options?.ttl ? Date.now() + options.ttl.total('milliseconds') : null
		)
	}
	async delete(key: KvKey) {
		await run(this.env, 'DELETE FROM federation_kv WHERE key=?', JSON.stringify(key))
	}
	async cas(key: KvKey, expected: unknown, value: unknown, options?: KvStoreSetOptions) {
		const expires = options?.ttl ? Date.now() + options.ttl.total('milliseconds') : null
		const result =
			expected === undefined
				? await run(
						this.env,
						`INSERT INTO federation_kv(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at WHERE federation_kv.expires_at<=?`,
						JSON.stringify(key),
						JSON.stringify(value),
						expires,
						Date.now()
					)
				: await run(
						this.env,
						'UPDATE federation_kv SET value=?,expires_at=? WHERE key=? AND value=? AND (expires_at IS NULL OR expires_at>?)',
						JSON.stringify(value),
						expires,
						JSON.stringify(key),
						JSON.stringify(expected),
						Date.now()
					)
		return result.meta.changes > 0
	}
	async *list(prefix?: KvKey) {
		let cursor = ''
		for (;;) {
			const rows = await all<{ key: string; value: string }>(
				this.env,
				'SELECT key,value FROM federation_kv WHERE key>? AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT 100',
				cursor,
				Date.now()
			)
			if (!rows.length) return
			for (const r of rows) {
				cursor = r.key
				const key = JSON.parse(r.key) as KvKey
				if (!prefix || prefix.every((v, i) => key[i] === v)) yield { key, value: JSON.parse(r.value) as unknown }
			}
		}
	}
}
export class D1MessageQueue implements MessageQueue {
	readonly nativeRetrial = true
	constructor(
		private env: Env,
		private processing?: QueueJobLease
	) {}
	async enqueue(message: unknown, options?: MessageQueueEnqueueOptions) {
		const time = Date.now(),
			m = message as import('@fedify/fedify').Message,
			raw = m.activity as Record<string, unknown>,
			type = m.type,
			activityId = m.type === 'inbox' ? String(raw?.id ?? m.id) : (m.activityId ?? m.id)
		const order = options?.orderingKey ?? (type === 'inbox' ? 'inbox:' + String(raw?.actor ?? 'unknown') : null)
		const id =
			'federation:' +
			(await digest(
				JSON.stringify([
					type,
					activityId,
					m.type === 'outbox' ? m.inbox : m.type === 'fanout' ? Object.keys(m.inboxes) : '',
				])
			))
		const payload = JSON.stringify({ messageCipher: await seal(this.env, message), orderingKey: order }),
			available = time + (options?.delay?.total('milliseconds') ?? 0)
		if (this.processing?.id === id) {
			// Fedify can re-enqueue a task for Retry-After or a circuit hold even
			// with native retries enabled. Keep its original place in the ledger
			// and release this lease so completion cannot erase the deferred task.
			await run(
				this.env,
				`UPDATE jobs SET payload=?,available_at=MIN(?,COALESCE(first_attempt_at,?)+604800000),state=CASE WHEN attempt>=100 OR first_attempt_at<=? THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,dispatch_until=NULL,last_error=CASE WHEN attempt>=100 OR first_attempt_at<=? THEN 'Remote delivery retry limit reached' ELSE 'Remote server deferred delivery' END WHERE id=? AND state='processing' AND lease_token=?`,
				payload,
				available,
				time,
				time - 7 * 86400000,
				time - 7 * 86400000,
				id,
				this.processing.token
			)
			return
		}
		await run(
			this.env,
			"INSERT OR IGNORE INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'federation.message',?,?,?)",
			id,
			payload,
			available,
			time
		)
	}
	async listen(_handler: (message: unknown) => void | Promise<void>, options?: MessageQueueListenOptions) {
		if (options?.signal?.aborted) return
		await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
	}
}

export interface QueueJobLease {
	id: string
	token: string
}
