import { ApiError } from '../http'

export const SCOPES = [
	'read',
	'write',
	'follow',
	'push',
	'profile',
	...[
		'accounts',
		'blocks',
		'bookmarks',
		'favourites',
		'filters',
		'follows',
		'lists',
		'mutes',
		'notifications',
		'search',
		'statuses',
	].map((s) => `read:${s}`),
	...[
		'accounts',
		'blocks',
		'bookmarks',
		'conversations',
		'favourites',
		'filters',
		'follows',
		'lists',
		'media',
		'mutes',
		'notifications',
		'reports',
		'statuses',
	].map((s) => `write:${s}`),
]
export function parseScopes(value: string): string[] {
	const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))].sort()
	if (!scopes.length || scopes.some((s) => !SCOPES.includes(s)))
		throw new ApiError(400, 'Unknown or empty scopes', 'invalid_scope')
	return scopes
}
export function permits(granted: string, needed: string): boolean {
	const scopes = granted.split(' ')
	return scopes.includes(needed) || scopes.includes(needed.split(':')[0]!)
}
export function subset(requested: string[], granted: string): boolean {
	return requested.every((scope) => permits(granted, scope))
}
