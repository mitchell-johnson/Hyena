import { readFile, writeFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { parse } from 'jsonc-parser'
const file = 'wrangler.local.generated.json',
	config = parse(await readFile('wrangler.jsonc', 'utf8'))
const origin = new URL(process.env.HYENA_LOCAL_ORIGIN || 'http://localhost:8787')
if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname))
	throw Error('HYENA_LOCAL_ORIGIN must use HTTP on a loopback hostname')
if (process.argv.includes('--remote')) throw Error('dev:local is restricted to local services')
config.vars = { ...config.vars, PUBLIC_ORIGIN: origin.origin, MAINTENANCE_MODE: 'false' }
delete config.images
delete config.media
delete config.send_email
delete config.services
await writeFile(file, JSON.stringify(config, null, 2))
console.log(
	'Local D1/R2/Queues/DOs. Images and Media transformations require a connected Cloudflare account; use npm run dev for those bindings.'
)
const child = spawn(
	process.execPath,
	[
		'node_modules/wrangler/bin/wrangler.js',
		'dev',
		'--ip',
		'127.0.0.1',
		'--port',
		origin.port || '80',
		'--config',
		file,
		...process.argv.slice(2),
	],
	{ stdio: 'inherit' }
)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('exit', async (code) => {
	await unlink(file).catch(() => {})
	process.exitCode = code ?? 0
})
