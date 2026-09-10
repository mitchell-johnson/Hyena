import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { parse } from 'jsonc-parser'
import { exportSnapshot } from './export-snapshot.mjs'

const [mode, directory, targetDatabase, targetBucket] = process.argv.slice(2).filter((x) => x !== '--execute')
const execute = process.argv.includes('--execute'),
	root = resolve(directory || 'backup')
if (!['backup', 'verify', 'restore'].includes(mode))
	throw Error(
		'Usage: node scripts/backup.mjs backup|verify DIRECTORY; restore DIRECTORY NEW_DATABASE NEW_BUCKET [--execute]'
	)
const config = parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const bucket = config.r2_buckets.find((b) => b.binding === 'MEDIA_BUCKET').bucket_name
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js')
async function run(command, args, capture = false) {
	const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] })
	let output = ''
	if (capture)
		child.stdout.on('data', (c) => {
			output += c
		})
	await new Promise((ok, fail) => {
		child.on('error', fail)
		child.on('exit', (code) => (code === 0 ? ok() : fail(Error(`${command} exited ${code}`))))
	})
	return output
}
async function hash(path) {
	const digest = createHash('sha256')
	for await (const bytes of createReadStream(path)) digest.update(bytes)
	return digest.digest('hex')
}
async function files(path) {
	const result = []
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const p = join(path, entry.name)
		if (entry.isSymbolicLink()) throw Error('Backup cannot contain symlinks')
		if (entry.isDirectory()) result.push(...(await files(p)))
		else if (entry.isFile()) result.push(p)
	}
	return result
}
const endpoint = `https://${account}.r2.cloudflarestorage.com`
function credentials() {
	for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])
		if (!process.env[key]) throw Error(`Set ${key}`)
	if (!/^[a-f0-9]{32}$/.test(account)) throw Error('Invalid account ID')
}
if (mode === 'backup') {
	credentials()
	const health = await fetch(config.vars.PUBLIC_ORIGIN + '/health/live', { signal: AbortSignal.timeout(10000) }).then(
		(r) => r.json()
	)
	if (!health.maintenance) throw Error('Enable MAINTENANCE_MODE=true before a consistent D1/R2 backup')
	const active = JSON.parse(
		await run(
			process.execPath,
			[
				wrangler,
				'd1',
				'execute',
				'DB',
				'--remote',
				'--json',
				'--command',
				"SELECT COUNT(*) n FROM jobs WHERE state='processing' AND lease_until>unixepoch('subsec')*1000",
			],
			true
		)
	)
	if (active[0]?.results?.[0]?.n !== 0) throw Error('Wait for active job leases to finish before backing up')
	await mkdir(root, { mode: 0o700 })
	await exportSnapshot({
		account,
		database: config.d1_databases.find((d) => d.binding === 'DB').database_id,
		token: process.env.CLOUDFLARE_API_TOKEN,
		file: join(root, 'database.sql'),
	})
	await run('aws', ['--endpoint-url', endpoint, 's3', 'sync', `s3://${bucket}`, join(root, 'objects'), '--no-progress'])
	await mkdir(join(root, 'objects'), { recursive: true })
	const metadata = {}
	for (const path of await files(join(root, 'objects'))) {
		const key = relative(join(root, 'objects'), path)
		metadata[key] = JSON.parse(
			await run('aws', ['--endpoint-url', endpoint, 's3api', 'head-object', '--bucket', bucket, '--key', key], true)
		)
	}
	await writeFile(join(root, 'object-metadata.json'), JSON.stringify(metadata), { mode: 0o600 })
	const entries = []
	for (const path of await files(root))
		entries.push({ path: relative(root, path), bytes: (await stat(path)).size, sha256: await hash(path) })
	await writeFile(
		join(root, 'manifest.json'),
		JSON.stringify(
			{
				version: 1,
				created_at: new Date().toISOString(),
				origin: config.vars.PUBLIC_ORIGIN,
				bucket,
				database: config.d1_databases[0].database_id,
				files: entries,
			},
			null,
			2
		),
		{ mode: 0o600 }
	)
	console.log(
		`Backup and checksums saved in ${root}. Preserve KEY_ENCRYPTION_SECRET separately; disable maintenance after verification.`
	)
} else {
	const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
	if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw Error('Unknown backup format')
	const available = new Set((await files(root)).map((path) => relative(root, path)))
	for (const required of ['database.sql', 'object-metadata.json'])
		if (!manifest.files.some((entry) => entry.path === required)) throw Error('Backup manifest is missing ' + required)
	for (const entry of manifest.files) {
		const path = resolve(root, entry.path)
		if (
			!available.has(entry.path) ||
			!path.startsWith(root + '/') ||
			(await hash(path)) !== entry.sha256 ||
			(await stat(path)).size !== entry.bytes
		)
			throw Error('Backup checksum or path validation failed: ' + entry.path)
	}
	if (mode === 'verify') {
		console.log(`Verified ${manifest.files.length} backup files`)
		process.exit(0)
	}
	if (
		!targetDatabase ||
		!/^[a-z0-9][a-z0-9-]{2,62}$/.test(targetBucket ?? '') ||
		targetBucket === manifest.bucket ||
		targetDatabase === manifest.database ||
		targetDatabase === 'DB'
	)
		throw Error('Restore requires a separate empty database and a separate bucket')
	console.log(
		`Restore verified backup to database ${targetDatabase} and bucket ${targetBucket}; canonical origin remains ${manifest.origin}.`
	)
	if (!execute) {
		console.log('No resources changed. Add --execute after creating empty targets and checking the runbook.')
		process.exit(0)
	}
	credentials()
	const tables = JSON.parse(
		await run(
			process.execPath,
			[
				wrangler,
				'd1',
				'execute',
				targetDatabase,
				'--remote',
				'--json',
				'--command',
				"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
			],
			true
		)
	)
	if (tables[0]?.results?.length !== 0) throw Error('Restore target database is not empty')
	const objects = JSON.parse(
		await run(
			'aws',
			['--endpoint-url', endpoint, 's3api', 'list-objects-v2', '--bucket', targetBucket, '--max-keys', '1'],
			true
		)
	)
	if (objects.KeyCount) throw Error('Restore target bucket is not empty')
	const metadata = JSON.parse(await readFile(join(root, 'object-metadata.json'), 'utf8'))
	for (const entry of manifest.files.filter((f) => f.path.startsWith('objects/'))) {
		const key = entry.path.slice(8),
			m = metadata[key] ?? {},
			args = [
				'--endpoint-url',
				endpoint,
				's3api',
				'put-object',
				'--bucket',
				targetBucket,
				'--key',
				key,
				'--body',
				join(root, entry.path),
			]
		for (const [field, flag] of [
			['ContentType', 'content-type'],
			['ContentDisposition', 'content-disposition'],
			['CacheControl', 'cache-control'],
			['ContentEncoding', 'content-encoding'],
			['ContentLanguage', 'content-language'],
			['Expires', 'expires'],
		])
			if (m[field]) args.push('--' + flag, String(m[field]))
		if (m.Metadata) args.push('--metadata', JSON.stringify(m.Metadata))
		await run('aws', args, true)
	}
	await run(process.execPath, [
		wrangler,
		'd1',
		'execute',
		targetDatabase,
		'--remote',
		'--file',
		join(root, 'database.sql'),
	])
	console.log(
		'Data restored. Keep traffic disabled while checking foreign keys, IDs, R2 metadata, media, encrypted keys and durable job recovery. See docs/operations.md.'
	)
}
