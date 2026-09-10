import type { Context } from 'hono'
import { Hono } from 'hono'
import { lookupToken } from '../auth/access'
import { permits } from '../auth/scopes'
import { ApiError } from '../http'
import type { AppEnv } from '../types'
export const streaming = new Hono<AppEnv>()
streaming.get('/api/v1/streaming/*', gateway)
streaming.get('/api/v1/streaming', gateway)
async function gateway(c: Context<AppEnv>) {
	const protocols =
			c.req
				.header('Sec-WebSocket-Protocol')
				?.split(',')
				.map((s) => s.trim()) ?? [],
		raw = c.req.header('Authorization')?.replace(/^Bearer /i, '') ?? c.req.query('access_token') ?? protocols[0],
		token = await lookupToken(c.env, raw)
	if (!token?.account_id) throw new ApiError(401, 'The access token is invalid')
	if (
		!permits(token.scopes, 'read:statuses') &&
		!(
			(c.req.query('stream') === 'user:notification' || c.req.path.endsWith('/user/notification')) &&
			permits(token.scopes, 'read:notifications')
		)
	)
		throw new ApiError(403, 'Missing read:statuses scope')
	const url = new URL(c.req.url),
		suffix = c.req.path.slice('/api/v1/streaming/'.length)
	if (c.req.path !== '/api/v1/streaming' && suffix) url.searchParams.set('stream', suffix.replaceAll('/', ':'))
	const headers = new Headers({ Upgrade: 'websocket', 'X-Hyena-Token': token.token_hash })
	if (protocols.includes(raw ?? '')) headers.set('Sec-WebSocket-Protocol', raw!)
	const response = await c.env.STREAMS.get(c.env.STREAMS.idFromName(token.account_id)).fetch(
		new Request(url, { headers })
	)
	if (c.req.header('Upgrade')?.toLowerCase() === 'websocket' || response.status !== 101) return response
	const socket = response.webSocket
	if (!socket) throw new ApiError(503, 'Streaming connection failed')
	socket.accept()
	let heartbeat: ReturnType<typeof setInterval> | undefined,
		closed = false
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder()
			const close = () => {
				if (closed) return
				closed = true
				if (heartbeat) clearInterval(heartbeat)
				try {
					controller.close()
				} catch {}
			}
			socket.addEventListener('message', (event) => {
				if (typeof event.data !== 'string' || closed) return
				try {
					const data = JSON.parse(event.data) as { event: string; payload: string }
					controller.enqueue(
						encoder.encode(`event: ${data.event}\ndata: ${data.payload.replaceAll('\n', '\ndata: ')}\n\n`)
					)
				} catch {}
			})
			socket.addEventListener('close', close)
			socket.addEventListener('error', close)
			controller.enqueue(encoder.encode(': connected\n\n'))
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'))
				} catch {
					close()
				}
			}, 30000)
		},
		cancel() {
			closed = true
			if (heartbeat) clearInterval(heartbeat)
			socket.close(1000, 'SSE disconnected')
		},
	})
	return new Response(body, {
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
	})
}
