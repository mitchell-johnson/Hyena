import type { StreamHub } from './streaming/hub'

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct'
export type MediaKind = 'image' | 'video' | 'audio'
export type JobMessage = { version: 1; id: string }

// Narrow provider interfaces allow real workerd/D1/R2 integration tests to
// substitute only the remote image/video transformation services.
export interface ImageService {
	info(input: ReadableStream<Uint8Array>): Promise<{ width: number; height: number; format: string }>
	input(input: ReadableStream<Uint8Array>): {
		transform(options: { width: number; height?: number; fit: 'scale-down' }): {
			output(options: { format: 'image/webp' }): Promise<{ response(): Response }>
		}
	}
}
export interface MediaService {
	input(input: ReadableStream<Uint8Array>): {
		output(options: { mode: 'video' | 'audio' | 'frame'; duration?: string; time?: string; format?: 'jpg' }): {
			response(): Promise<Response>
		}
	}
}
export interface Env {
	DB: D1Database
	MEDIA_BUCKET: R2Bucket
	JOBS: Queue<JobMessage>
	STREAMS: DurableObjectNamespace<StreamHub>
	IMAGES: ImageService
	MEDIA: MediaService
	AUTH_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> }
	PUBLIC_ORIGIN: string
	INSTANCE_TITLE: string
	INSTANCE_DESCRIPTION: string
	MAX_MEDIA_BYTES?: string
	SETUP_TOKEN?: string
}
export interface AccountRow {
	id: string
	username: string
	display_name: string
	note: string
	password_hash: string
	created_at: string
}
export interface AppRow {
	id: string
	name: string
	website: string | null
	client_id: string
	secret_hash: string
	redirect_uris: string
	scopes: string
	created_at: string
}
export interface TokenRow {
	token_hash: string
	app_id: string
	account_id: string | null
	scopes: string
	created_at: number
	revoked_at: number | null
}
export interface StatusRow {
	id: string
	account_id: string
	text: string
	content: string
	spoiler_text: string
	visibility: Visibility
	sensitive: number
	language: string | null
	in_reply_to_id: string | null
	created_at: string
	edited_at: string | null
	deleted_at: string | null
	revision: number
	mutation_id: string
	request_key: string | null
	request_hash: string | null
}
export interface MediaRow {
	id: string
	account_id: string
	status_id: string | null
	state: string
	original_key: string
	output_key: string | null
	preview_key: string | null
	mime_type: string
	media_type: MediaKind
	bytes: number
	description: string | null
	focus_x: number
	focus_y: number
	metadata: string
	error: string | null
	created_at: number
	updated_at: number
}
export interface JobRow {
	id: string
	kind: 'status.event' | 'media.process'
	payload: string
	state: string
	attempt: number
	available_at: number
	lease_token: string | null
	lease_until: number | null
}
export type AppEnv = { Bindings: Env; Variables: { token: TokenRow; account: AccountRow; requestId: string } }
