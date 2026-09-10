import type { Env } from './types'

export function accountDomain(env: Pick<Env, 'PUBLIC_ORIGIN' | 'ACCOUNT_DOMAIN'>): string {
	return env.ACCOUNT_DOMAIN || new URL(env.PUBLIC_ORIGIN).host
}

export function isLocalAccountDomain(env: Pick<Env, 'PUBLIC_ORIGIN' | 'ACCOUNT_DOMAIN'>, domain?: string): boolean {
	return !domain || [accountDomain(env), new URL(env.PUBLIC_ORIGIN).host].includes(domain.toLowerCase())
}
