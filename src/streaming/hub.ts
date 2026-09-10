import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'

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
}
const supported = new Set(['user', 'public', 'public:local'])

export class StreamHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)')
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
	}
	async fetch(request: Request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
			return new Response('WebSocket required', { status: 426 })
		if (this.ctx.getWebSockets().length >= 20) return new Response('Connection limit reached', { status: 429 })
		const tokenHash = request.headers.get('X-Hyena-Token')
		if (!tokenHash) return new Response('Unauthorized', { status: 401 })
		const stream = new URL(request.url).searchParams.get('stream')
		if (stream && !supported.has(stream)) return new Response('Stream not implemented', { status: 400 })
		const pair = new WebSocketPair()
		this.ctx.acceptWebSocket(pair[1])
		pair[1].serializeAttachment({ tokenHash, streams: stream ? [stream] : [] } satisfies SocketState)
		return new Response(null, { status: 101, webSocket: pair[0] })
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
			const input = JSON.parse(message) as { type: string; stream: string }
			if (!supported.has(input.stream) || !['subscribe', 'unsubscribe'].includes(input.type)) throw new Error()
			state.streams =
				input.type === 'subscribe'
					? [...new Set([...state.streams, input.stream])]
					: state.streams.filter((s) => s !== input.stream)
			socket.serializeAttachment(state)
		} catch {
			socket.send(JSON.stringify({ error: 'Unsupported subscription' }))
		}
	}
	async active(hash: string) {
		return Boolean(
			await this.env.DB.prepare(
				'SELECT 1 FROM oauth_tokens WHERE token_hash=? AND revoked_at IS NULL AND account_id IS NOT NULL'
			)
				.bind(hash)
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
				if (stream !== 'user' && !event.public && event.event !== 'delete') continue
				try {
					socket.send(JSON.stringify({ stream: [stream], event: event.event, payload: event.payload }))
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
		socket.close(code, reason)
	}
	webSocketError(socket: WebSocket) {
		socket.close(1011, 'Reconnect to refresh')
	}
}
