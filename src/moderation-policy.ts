import { isIP } from 'node:net'
import { all, parsed, setting } from './data'
import { digest } from './auth/crypto'
import { ApiError } from './http'
import type { Env } from './types'
// SQL predicates keep cached data subject to current instance policy without
// rewriting remote accounts when a moderator adds or removes a domain rule.
export function allowedAccountSQL(a = 'a') {
	const match = `${a}.domain=r.value OR ${a}.domain LIKE '%.'||r.value`
	return `(${a}.domain='' OR (NOT EXISTS(SELECT 1 FROM moderation_rules r WHERE r.kind='domain_blocks' AND (${match}) AND json_extract(r.data,'$.severity')='suspend') AND (COALESCE((SELECT value FROM settings WHERE key='limited_federation'),'false')<>'true' OR EXISTS(SELECT 1 FROM moderation_rules r WHERE r.kind='domain_allows' AND (${match})))))`
}
export function limitedAccountSQL(a = 'a') {
	return `(${a}.silenced=1 OR EXISTS(SELECT 1 FROM moderation_rules r WHERE r.kind='domain_blocks' AND (${a}.domain=r.value OR ${a}.domain LIKE '%.'||r.value) AND json_extract(r.data,'$.severity')='silence'))`
}
function ipNumber(ip: string): { bits: number; value: bigint } | null {
	const version = isIP(ip)
	if (version === 4) return { bits: 32, value: ip.split('.').reduce((n, v) => (n << 8n) + BigInt(v), 0n) }
	if (version !== 6) return null
	let text = ip.toLowerCase()
	if (text.includes('.')) {
		const at = text.lastIndexOf(':'),
			v4 = ipNumber(text.slice(at + 1))
		if (!v4) return null
		text = text.slice(0, at + 1) + (v4.value >> 16n).toString(16) + ':' + (v4.value & 65535n).toString(16)
	}
	const parts = text.split('::'),
		left = parts[0]!.split(':').filter(Boolean),
		right = (parts[1] ?? '').split(':').filter(Boolean),
		groups = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
	if (groups.length !== 8) return null
	return { bits: 128, value: groups.reduce((n, v) => (n << 16n) + BigInt('0x' + v), 0n) }
}
export function cidr(value: string) {
	const [ip, bits, ...extra] = value.split('/'),
		address = ipNumber(ip ?? ''),
		prefix = bits === undefined ? address?.bits : Number(bits)
	if (!address || extra.length || !Number.isInteger(prefix) || prefix! < 0 || prefix! > address.bits)
		throw new ApiError(422, 'Invalid IP address or CIDR range')
	return { value: address.value, bits: address.bits, prefix: prefix! }
}
export function inRange(ip: string, range: string) {
	const address = ipNumber(ip)
	if (!address) return false
	const network = cidr(range)
	return (
		address.bits === network.bits &&
		address.value >> BigInt(network.bits - network.prefix) === network.value >> BigInt(network.bits - network.prefix)
	)
}
export async function ipPolicy(env: Env, ip: string | undefined) {
	if (!ip) return null
	const rows = await all<{ value: string; data: string }>(
			env,
			"SELECT value,data FROM moderation_rules WHERE kind='ip_blocks'"
		),
		rank = ['sign_up_requires_approval', 'sign_up_block', 'no_access']
	let selected: string | null = null
	for (const r of rows) {
		const d = parsed<{ severity: string; expires_at?: string }>(r.data, {} as never)
		if (d.expires_at && Date.parse(d.expires_at) <= Date.now()) continue
		if (inRange(ip, r.value) && rank.indexOf(d.severity) > rank.indexOf(selected ?? '')) selected = d.severity
	}
	return selected
}
export async function domainPolicy(env: Env, domain: string) {
	const rows = await all<{ kind: string; value: string; data: string }>(
			env,
			"SELECT kind,value,data FROM moderation_rules WHERE kind IN ('domain_blocks','domain_allows')"
		),
		matching = rows.filter((r) => domain === r.value || domain.endsWith('.' + r.value)),
		allowed = matching.some((r) => r.kind === 'domain_allows'),
		rules = matching.filter((r) => r.kind === 'domain_blocks').map((r) => parsed<Record<string, unknown>>(r.data, {}))
	return {
		suspended:
			rules.some((r) => r.severity === 'suspend') || ((await setting(env, 'limited_federation', false)) && !allowed),
		limited: rules.some((r) => r.severity === 'silence'),
		rejectMedia: rules.some((r) => r.reject_media === true),
		rejectReports: rules.some((r) => r.reject_reports === true),
	}
}
export async function canonicalEmail(value: string) {
	let [local, domain] = value.trim().toLowerCase().split('@')
	if (!local || !domain) throw new ApiError(422, 'Invalid email')
	if (['gmail.com', 'googlemail.com'].includes(domain)) {
		local = local.split('+')[0]!.replaceAll('.', '')
		domain = 'gmail.com'
	} else local = local.split('+')[0]!
	return digest(local + '@' + domain)
}
