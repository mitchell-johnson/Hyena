export async function nextId(db: D1Database): Promise<string> {
	// Bind/return decimal text. D1's JS number mapping must never round public IDs.
	const seed = (BigInt(Date.now()) << 16n).toString()
	const row = await db
		.prepare(
			`INSERT INTO sequences(name, value) VALUES ('public', CAST(? AS INTEGER))
    ON CONFLICT(name) DO UPDATE SET value = MAX(value + 1, excluded.value)
    RETURNING CAST(value AS TEXT) AS id`
		)
		.bind(seed)
		.first<{ id: string }>()
	if (!row) throw new Error('ID allocation failed')
	return row.id
}

export function isId(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
}
