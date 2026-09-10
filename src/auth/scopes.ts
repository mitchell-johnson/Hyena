import { ApiError } from '../http'

export const SCOPES = [
	'read',
	'write',
	'follow',
	'push',
	'profile',
	'admin:read',
	'admin:write',
	'admin:read:accounts',
	'admin:write:accounts',
	'admin:read:reports',
	'admin:write:reports',
	'admin:read:domain_allows',
	'admin:write:domain_allows',
	'admin:read:domain_blocks',
	'admin:write:domain_blocks',
	'admin:read:ip_blocks',
	'admin:write:ip_blocks',
	'admin:read:email_domain_blocks',
	'admin:write:email_domain_blocks',
	'admin:read:canonical_email_blocks',
	'admin:write:canonical_email_blocks',
	...[
		'accounts',
		'blocks',
		'bookmarks',
		'collections',
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
		'collections',
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
	return (
		scopes.some((scope) => needed === scope || needed.startsWith(scope + ':')) ||
		(scopes.includes('follow') && /^(read|write):(follows|blocks|mutes)$/.test(needed))
	)
}
export function subset(requested: string[], granted: string): boolean {
	return requested.every((scope) => permits(granted, scope))
}
