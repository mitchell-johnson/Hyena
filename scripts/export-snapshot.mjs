import { open } from 'node:fs/promises'
// SQLite emits SQL literals as TEXT. This avoids a JS-number round trip for
// 64-bit sequence columns (the stock D1 export documents a precision caveat).
export async function exportSnapshot({ account, database, token, file }) {
	async function query(sql, params = []) {
		const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql, params }),
			signal: AbortSignal.timeout(30000),
		})
		const j = await r.json()
		if (!r.ok || !j.success || !j.result?.[0]?.success)
			throw Error('D1 snapshot query failed: ' + (j.errors?.map((e) => e.message).join('; ') ?? r.status))
		return j.result[0].results
	}
	const quoteName = (s) => '"' + s.replaceAll('"', '""') + '"'
	if ((await query('PRAGMA foreign_key_check')).length)
		throw Error('Foreign-key violations must be resolved before backup')
	const schema = await query(
		"SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid"
	)
	if (schema.some((s) => /CREATE VIRTUAL TABLE/i.test(s.sql)))
		throw Error('This snapshot exporter needs an explicit virtual-table rebuild strategy')
	const out = await open(file, 'wx', 0o600),
		buffer = quoteName('hyena_snapshot_' + crypto.randomUUID().replaceAll('-', ''))
	let hasBuffer = false,
		cellId = 0
	async function bufferedCell(expression) {
		const match = /^(?:CAST\()?X'([0-9A-F]*)'(?: AS TEXT\))?$/.exec(expression)
		if (!match) throw Error('Oversized snapshot value must be text or a blob')
		if (!hasBuffer) {
			await out.write(`CREATE TABLE ${buffer}(id INTEGER PRIMARY KEY,value BLOB);\n`)
			hasBuffer = true
		}
		const id = ++cellId,
			hex = match[1]
		await out.write(`INSERT INTO ${buffer} VALUES(${id},X'');\n`)
		for (let offset = 0; offset < hex.length; offset += 60000)
			await out.write(
				`UPDATE ${buffer} SET value=CAST(value||X'${hex.slice(offset, offset + 60000)}' AS BLOB) WHERE id=${id};\n`
			)
		return `(SELECT ${expression.startsWith('CAST(') ? 'CAST(value AS TEXT)' : 'value'} FROM ${buffer} WHERE id=${id})`
	}
	try {
		await out.write('PRAGMA defer_foreign_keys = ON;\n')
		for (const table of schema.filter((s) => s.type === 'table')) await out.write(table.sql + ';\n')
		for (const table of schema.filter((s) => s.type === 'table')) {
			const columns = (await query('PRAGMA table_info(' + quoteName(table.name) + ')')).map((c) => quoteName(c.name)),
				prefix = 'INSERT INTO ' + quoteName(table.name) + '(' + columns.join(',') + ') VALUES('
			let cursor = null
			for (;;) {
				const rows = await query(
					`SELECT CAST(rowid AS TEXT) cursor,json_array(${columns.map((c) => `CASE WHEN typeof(${c})='text' THEN 'CAST(X'''||hex(${c})||''' AS TEXT)' ELSE quote(${c}) END`).join(',')}) cells FROM ${quoteName(table.name)} WHERE (? IS NULL OR rowid>CAST(? AS INTEGER)) ORDER BY rowid LIMIT 25`,
					[cursor, cursor]
				)
				if (!rows.length) break
				for (const row of rows) {
					const cells = JSON.parse(row.cells)
					let statement = prefix + cells.join(',') + ');'
					if (Buffer.byteLength(statement) > 90000) {
						for (let i = 0; i < cells.length; i++) if (cells[i].length > 1000) cells[i] = await bufferedCell(cells[i])
						statement = prefix + cells.join(',') + ');'
					}
					if (Buffer.byteLength(statement) > 90000) throw Error('Snapshot row still exceeds the SQL statement budget')
					await out.write(statement + '\n')
					if (hasBuffer) await out.write(`DELETE FROM ${buffer};\n`)
				}
				cursor = rows.at(-1).cursor
			}
		}
		if (hasBuffer) await out.write(`DROP TABLE ${buffer};\n`)
		for (const item of schema.filter((s) => s.type !== 'table')) await out.write(item.sql + ';\n')
		await out.write('PRAGMA defer_foreign_keys = OFF;\n')
	} finally {
		await out.close()
	}
}
