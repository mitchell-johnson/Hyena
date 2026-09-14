import { applyD1Migrations, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env, request, runtime, seed } from './support'
import { one, run } from '../src/data'
import { nextId } from '../src/db'
import { statusEvent } from '../src/events'
import type { StatusEvent } from '../src/streaming/hub'
import type { Env, StatusRow } from '../src/types'

const publicStreams = [
	'public',
	'public:local',
	'public:remote',
	'public:media',
	'public:local:media',
	'public:remote:media',
]

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => reset())

it.each(publicStreams)('removes query and path aliases for %s before connecting', async (stream) => {
	const owner = await seed('owner'),
		connect = vi.fn(() => {
			throw new Error('Removed streams must never connect')
		}),
		bindings = { ...env, STREAMS: { idFromName: connect } as unknown as Env['STREAMS'] }
	for (const path of ['/api/v1/streaming?stream=' + stream, '/api/v1/streaming/' + stream.replaceAll(':', '/')])
		for (const token of [undefined, owner.token])
			for (const headers of [{}, { Upgrade: 'websocket' }] as Record<string, string>[]) {
				const response = await request(path, { token, headers, bindings })
				expect(response.status).toBe(404)
				expect(await response.json()).toEqual({ error: 'Stream not found' })
			}
	expect(connect).not.toHaveBeenCalled()
})

function nextMessage(socket: WebSocket) {
	return new Promise<Record<string, unknown>>((resolve) =>
		socket.addEventListener('message', (message) => resolve(JSON.parse(message.data as string)), { once: true })
	)
}

it('rejects public subscriptions on an authenticated socket while retaining Home streaming', async () => {
	const owner = await seed('owner'),
		response = await request('/api/v1/streaming?stream=user', {
			token: owner.token,
			headers: { Upgrade: 'websocket' },
		})
	expect(response.status).toBe(101)
	const socket = response.webSocket!
	socket.accept()
	for (const stream of publicStreams) {
		const rejected = nextMessage(socket)
		socket.send(JSON.stringify({ type: 'subscribe', stream }))
		expect(await rejected).toEqual({ error: 'Unsupported subscription' })
	}
	const received = nextMessage(socket)
	await env.STREAMS.get(env.STREAMS.idFromName(owner.id)).publish({
		id: 'home-post',
		revision: 1,
		event: 'update',
		payload: '{"id":"home-post"}',
		public: true,
		sources: ['user'],
	})
	expect(await received).toEqual({ stream: ['user'], event: 'update', payload: '{"id":"home-post"}' })
	socket.close(1000, 'Test complete')
})

it('does not deliver to removed subscriptions restored from hibernated attachments', async () => {
	const owner = await seed('owner'),
		response = await request('/api/v1/streaming?stream=user', {
			token: owner.token,
			headers: { Upgrade: 'websocket' },
		}),
		socket = response.webSocket!,
		stub = env.STREAMS.get(env.STREAMS.idFromName(owner.id))
	socket.accept()
	await runInDurableObject(stub, (_instance, state) => {
		const stored = state.getWebSockets()[0]!,
			attachment = stored.deserializeAttachment()
		stored.serializeAttachment({ ...attachment, streams: ['user', 'user:notification', ...publicStreams] })
	})
	await evictDurableObject(stub)
	const messages: Record<string, unknown>[] = []
	socket.addEventListener('message', (message) => {
		messages.push(JSON.parse(message.data as string))
	})
	await stub.publish({
		id: 'queued-before-deploy',
		revision: 1,
		event: 'update',
		payload: 'queued post',
		public: true,
		sources: ['user', ...publicStreams],
	})
	await stub.publish({ id: 'legacy-event', revision: 1, event: 'update', payload: 'legacy post', public: true })
	const finished = new Promise<void>((resolve) =>
		socket.addEventListener('message', (message) => {
			if (JSON.parse(message.data as string).payload === 'final notification') resolve()
		})
	)
	await stub.sendEvent('notification', 'final notification', [...publicStreams, 'user:notification'])
	await finished
	expect(messages).toEqual([
		{ stream: ['user'], event: 'update', payload: 'queued post' },
		{ stream: ['user'], event: 'update', payload: 'legacy post' },
		{ stream: ['user:notification'], event: 'notification', payload: 'final notification' },
	])
	socket.close(1000, 'Test complete')
})

it('publishes followed posts only to remaining Home, list and hashtag sources', async () => {
	const owner = await seed('owner'),
		id = await nextId(env.DB),
		created = new Date().toISOString()
	await run(
		env,
		'INSERT INTO accounts(id,username,domain,uri,created_at) VALUES(?,?,?,?,?)',
		'remote-author',
		'author',
		'remote.example',
		'https://remote.example/users/author',
		created
	)
	await env.DB.batch([
		env.DB.prepare("INSERT INTO follows(id,follower_id,following_id,state,created_at) VALUES(?,?,?,'accepted',?)").bind(
			'follow',
			owner.id,
			'remote-author',
			created
		),
		env.DB.prepare('INSERT INTO lists(id,account_id,title) VALUES(?,?,?)').bind('list', owner.id, 'A list'),
		env.DB.prepare('INSERT INTO list_accounts(list_id,account_id) VALUES(?,?)').bind('list', 'remote-author'),
		env.DB.prepare('INSERT INTO tags(name,display_name,created_at) VALUES(?,?,?)').bind('topic', 'topic', created),
		env.DB.prepare(
			"INSERT INTO statuses(id,sequence,account_id,text,content,visibility,created_at,mutation_id,local) VALUES(?,CAST(? AS INTEGER),?,?,?,'public',?,?,0)"
		).bind(id, id, 'remote-author', 'A post #topic', '<p>A post #topic</p>', created, crypto.randomUUID()),
		env.DB.prepare('INSERT INTO status_tags(status_id,tag) VALUES(?,?)').bind(id, 'topic'),
	])
	const publish = vi.fn(async (_event: StatusEvent) => {}),
		bindings = {
			...env,
			STREAMS: {
				idFromName: (name: string) => name,
				get: () => ({ publish }),
			} as unknown as Env['STREAMS'],
		}
	await statusEvent(bindings, (await one<StatusRow>(env, 'SELECT * FROM statuses WHERE id=?', id))!)
	expect(publish).toHaveBeenCalledOnce()
	expect(publish.mock.calls[0]![0].sources).toEqual(['user', 'hashtag|topic', 'list|list'])
})
