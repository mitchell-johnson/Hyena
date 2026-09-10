import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { permits } from '../auth/scopes'

interface SocketState {
	tokenHash: string
	streams: string[]
}
export interface StatusEvent {
	id: string
	revision: number
	event: string
	payload: string
	public: boolean
	sources?: string[]
}
const supported = new Set([
	'user',
	'user:notification',
	'public',
	'public:local',
	'public:remote',
	'public:media',
	'public:local:media',
	'public:remote:media',
	'direct',
	'hashtag',
	'hashtag:local',
	'list',
])

export class StreamHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)')
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
	}
	async revokeAll() {
		for (const socket of this.ctx.getWebSockets()) socket.close(1008, 'Account sessions revoked')
	}
	async fetch(request: Request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
			return new Response('WebSocket required', { status: 426 })
		if (this.ctx.getWebSockets().length >= 20) return new Response('Connection limit reached', { status: 429 })
		const tokenHash = request.headers.get('X-Hyena-Token')
		if (!tokenHash) return new Response('Unauthorized', { status: 401 })
		const params = new URL(request.url).searchParams
		const name = params.get('stream'),
			stream = name ? await this.subscription(name, params.get('tag') ?? params.get('list'), tokenHash) : null
		if (name && !stream) return new Response('Stream not implemented', { status: 400 })
		const pair = new WebSocketPair()
		this.ctx.acceptWebSocket(pair[1])
		pair[1].serializeAttachment({ tokenHash, streams: stream ? [stream] : [] } satisfies SocketState)
		return new Response(null, {
			status: 101,
			webSocket: pair[0],
			headers: request.headers.get('Sec-WebSocket-Protocol')
				? { 'Sec-WebSocket-Protocol': request.headers.get('Sec-WebSocket-Protocol')! }
				: {},
		})
	}
	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== 'string' || message.length > 4096) {
			socket.close(1008, 'Invalid message')
			return
		}
		const state = socket.deserializeAttachment() as SocketState
		if (!(await this.active(state.tokenHash))) {
			socket.close(1008, 'Token revoked')
			return
		}
		try {
			const input = JSON.parse(message) as { type: string; stream: string; tag?: string; list?: string }
			const stream = await this.subscription(input.stream, input.tag ?? input.list ?? null, state.tokenHash)
			if (!stream || (input.type === 'subscribe' && state.streams.length >= 16)) throw new Error()
			if (!supported.has(input.stream) || !['subscribe', 'unsubscribe'].includes(input.type)) throw new Error()
			state.streams =
				input.type === 'subscribe'
					? [...new Set([...state.streams, stream])]
					: state.streams.filter((s) => s !== stream)
			socket.serializeAttachment(state)
		} catch {
			socket.send(JSON.stringify({ error: 'Unsupported subscription' }))
		}
	}
	async subscription(name: string, value: string | null, hash: string) {
		if (!supported.has(name)) return null
		const token = await this.env.DB.prepare('SELECT scopes FROM oauth_tokens WHERE token_hash=?')
			.bind(hash)
			.first<{ scopes: string }>()
		if (
			!token ||
			!(await this.active(hash)) ||
			!permits(token.scopes, name === 'user:notification' ? 'read:notifications' : 'read:statuses')
		)
			return null
		if (name === 'list') {
			if (
				!value ||
				!(await this.env.DB.prepare(
					'SELECT 1 FROM lists l JOIN oauth_tokens t ON t.account_id=l.account_id WHERE l.id=? AND t.token_hash=? AND t.revoked_at IS NULL'
				)
					.bind(value, hash)
					.first())
			)
				return null
			return name + '|' + value
		}
		if (name.startsWith('hashtag')) {
			if (!value || !/^[\p{L}\p{N}_]{1,100}$/u.test(value)) return null
			return name + '|' + value.toLocaleLowerCase()
		}
		return name
	}
	async sendEvent(event: string, payload: string, streams: string[] = ['user']) {
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as SocketState
			const token = await this.env.DB.prepare(
				'SELECT scopes FROM oauth_tokens WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)'
			)
				.bind(state.tokenHash, Date.now())
				.first<{ scopes: string }>()
			if (!token || !(await this.active(state.tokenHash))) {
				socket.close(1008, 'Token revoked')
				continue
			}
			if (event === 'notification' && !permits(token.scopes, 'read:notifications')) continue
			for (const stream of state.streams)
				if (streams.includes(stream))
					try {
						socket.send(JSON.stringify({ stream: stream.split('|'), event, payload }))
					} catch {
						socket.close(1011, 'Reconnect to refresh')
					}
		}
	}

	async active(hash: string) {
		return Boolean(
			await this.env.DB.prepare(
				'SELECT 1 FROM oauth_tokens t JOIN accounts a ON a.id=t.account_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND a.disabled=0 AND a.suspended=0 AND a.approved=1 AND (a.email IS NULL OR a.email_confirmed=1) AND (t.expires_at IS NULL OR t.expires_at>?)'
			)
				.bind(hash, Date.now())
				.first()
		)
	}
	async publish(event: StatusEvent) {
		const previous = this.ctx.storage.sql
			.exec<{ revision: number }>('SELECT revision FROM revisions WHERE id=?', event.id)
			.toArray()[0]
		if (previous && previous.revision >= event.revision) return
		// REST is authoritative across a disconnect. Duplicate events are possible
		// after a crash; this cursor suppresses ordinary queue redelivery.
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as SocketState
			if (!(await this.active(state.tokenHash))) {
				socket.close(1008, 'Token revoked')
				continue
			}
			for (const stream of state.streams) {
				if (event.sources ? !event.sources.includes(stream) : stream !== 'user' && !event.public) continue
				try {
					socket.send(JSON.stringify({ stream: stream.split('|'), event: event.event, payload: event.payload }))
				} catch {
					socket.close(1011, 'Reconnect to refresh')
					break
				}
			}
		}
		this.ctx.storage.sql.exec(
			'INSERT INTO revisions(id,revision) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision',
			event.id,
			event.revision
		)
	}
	async revoke(hash: string) {
		for (const socket of this.ctx.getWebSockets())
			if ((socket.deserializeAttachment() as SocketState).tokenHash === hash) socket.close(1008, 'Token revoked')
	}
	webSocketClose(socket: WebSocket, code: number, reason: string) {
		// 1005/1006/1015 describe transport closure and cannot go on the wire.
		socket.close([1004, 1005, 1006, 1015].includes(code) ? 1000 : code, reason)
	}
	webSocketError(socket: WebSocket) {
		socket.close(1011, 'Reconnect to refresh')
	}
}
