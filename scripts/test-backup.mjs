import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSnapshot } from './export-snapshot.mjs'
test('snapshot round-trips 64-bit integers, blobs and hostile SQL-shaped text without rounding or execution', async () => {
	const db = new DatabaseSync(':memory:'),
		restored = new DatabaseSync(':memory:'),
		directory = await mkdtemp(join(tmpdir(), 'hyena-backup-'))
	const originalFetch = globalThis.fetch
	try {
		db.exec(
			'CREATE TABLE statuses(id TEXT PRIMARY KEY, sequence INTEGER UNIQUE, content TEXT, image BLOB);CREATE INDEX status_sequence ON statuses(sequence);CREATE TABLE sequences(name TEXT PRIMARY KEY,value INTEGER);'
		)
		const id = '117245000875638791',
			content = "Line one;\nINSERT INTO statuses VALUES('another',99,'unsafe',NULL);\nA quote: ' and an emoji 🐾"
		db.prepare('INSERT INTO statuses VALUES(?,?,?,?)').run(id, BigInt(id), content, Buffer.from([0, 255, 1]))
		db.prepare('INSERT INTO statuses(rowid,id,sequence,content,image) VALUES(-1,?,?,?,?)').run(
			'negative-rowid',
			-1,
			'Embedded\0null and unicode 🐾',
			Buffer.from([0, 255])
		)
		db.prepare('INSERT INTO statuses VALUES(?,?,?,?)').run(
			'large',
			1,
			'A large import row 🐾\0'.repeat(9000),
			Buffer.alloc(150000, 255)
		)
		db.prepare('INSERT INTO sequences VALUES(?,?)').run('public', BigInt(id) + 7n)
		globalThis.fetch = async (_url, options) => {
			const { sql, params } = JSON.parse(options.body),
				results = db.prepare(sql).all(...params)
			return Response.json({ success: true, result: [{ success: true, results }] })
		}
		const file = join(directory, 'database.sql')
		await exportSnapshot({ account: 'test', database: 'test', token: 'test', file })
		const sql = await readFile(file, 'utf8')
		assert.ok(
			sql.split('\n').every((line) => Buffer.byteLength(line) < 100000),
			'Every restore statement fits the D1 SQL budget'
		)
		restored.exec(sql)
		assert.deepEqual(
			restored.prepare('SELECT id,CAST(sequence AS TEXT) sequence,content,hex(image) image FROM statuses').all(),
			db.prepare('SELECT id,CAST(sequence AS TEXT) sequence,content,hex(image) image FROM statuses').all()
		)
		assert.equal(
			restored.prepare('SELECT CAST(value AS TEXT) value FROM sequences').get().value,
			(BigInt(id) + 7n).toString()
		)
	} finally {
		globalThis.fetch = originalFetch
		db.close()
		restored.close()
		await rm(directory, { recursive: true })
	}
})
