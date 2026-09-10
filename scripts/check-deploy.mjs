import { readFileSync } from 'node:fs'
import { parse } from 'jsonc-parser'

const errors = []
const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), errors, {
	allowTrailingComma: true,
})
if (errors.length || !config) {
	console.error('wrangler.jsonc is not valid JSONC. Fix it before deploying.')
	process.exit(1)
}
const origin = config.vars?.PUBLIC_ORIGIN
let validOrigin = false
try {
	const url = new URL(origin)
	validOrigin = url.protocol === 'https:' && url.origin === origin && !['localhost', '127.0.0.1'].includes(url.hostname)
} catch {}
const database = config.d1_databases?.find((db) => db.binding === 'DB')
if (!validOrigin || !database?.database_id || database.database_id === '00000000-0000-0000-0000-000000000000') {
	console.error(
		'Configure a canonical HTTPS PUBLIC_ORIGIN and a new Hyena D1 database_id in wrangler.jsonc before deploying. See README.md.'
	)
	process.exit(1)
}
console.log('Deployment configuration names an HTTPS origin and a D1 database.')
