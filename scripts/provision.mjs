import { readFile, writeFile } from 'node:fs/promises'
import { parse, modify, applyEdits } from 'jsonc-parser'
const path = new URL('../wrangler.jsonc', import.meta.url),
	text = await readFile(path, 'utf8'),
	config = parse(text)
const database = config.d1_databases.find((x) => x.binding === 'DB'),
	bucket = config.r2_buckets.find((x) => x.binding === 'MEDIA_BUCKET')
console.log(
	JSON.stringify(
		{
			worker: config.name,
			origin: config.vars.PUBLIC_ORIGIN,
			database: database.database_name,
			bucket: bucket.bucket_name,
			queues: [
				...new Set([
					...config.queues.producers.map((x) => x.queue),
					...config.queues.consumers.flatMap((x) => [x.queue, x.dead_letter_queue]).filter(Boolean),
				]),
			],
		},
		null,
		2
	)
)
if (!process.argv.includes('--execute')) {
	console.log(
		'Plan only. Configure the HTTPS origin and account credentials, then pass --execute to create missing resources.'
	)
	process.exit(0)
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID,
	token = process.env.CLOUDFLARE_API_TOKEN
if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token) throw Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')
const origin = new URL(config.vars.PUBLIC_ORIGIN)
if (origin.protocol !== 'https:' || origin.origin !== config.vars.PUBLIC_ORIGIN)
	throw Error('Configure a canonical HTTPS origin first')
async function api(path, method = 'GET', body) {
	const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(30000),
	})
	const json = await r.json()
	if (!r.ok || !json.success)
		throw Error(`Cloudflare ${method} ${path}: ${json.errors?.map((e) => e.message).join('; ') ?? r.status}`)
	return json.result
}
let db = (await api('/d1/database?per_page=100')).find((x) => x.name === database.database_name)
if (!db) db = await api('/d1/database', 'POST', { name: database.database_name })
const buckets = (await api('/r2/buckets')).buckets
if (!buckets.some((x) => x.name === bucket.bucket_name)) await api('/r2/buckets', 'POST', { name: bucket.bucket_name })
const queues = await api('/queues?per_page=100')
for (const name of new Set([
	...config.queues.producers.map((x) => x.queue),
	...config.queues.consumers.flatMap((x) => [x.queue, x.dead_letter_queue]).filter(Boolean),
]))
	if (!queues.some((x) => x.queue_name === name)) await api('/queues', 'POST', { queue_name: name })
await writeFile(
	path,
	applyEdits(
		text,
		modify(text, ['d1_databases', config.d1_databases.indexOf(database), 'database_id'], db.uuid, {
			formattingOptions: { insertSpaces: false, tabSize: 2 },
		})
	)
)
console.log(
	'Resources are available and the D1 ID is recorded. Provision Images/Media and optional Email in the account; set secrets, migrate, then deploy using docs/operations.md. No Worker was deployed.'
)
