import { it, expect } from 'vitest'
import { app } from '../src/index'
import contract from '../docs/mastodon-routes.json'
const normalize = (path: string) => path.replace(/:[A-Za-z_]+/g, ':id')
it('registers every REST route in the pinned Mastodon API contract', () => {
	const routes = app.routes.filter((r) => r.method !== 'ALL' && r.path !== '/api/*')
	const missing = contract.routes.filter(
		(expected) =>
			!routes.some((r) => {
				const method = r.method === expected.method || (expected.method === 'PATCH' && r.method === 'PUT')
				return method && normalize(r.path) === expected.path
			})
	)
	expect(missing).toEqual([])
})
