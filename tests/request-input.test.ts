import { expect, it } from 'vitest'
import { readInput } from '../src/http'

const endpoint = 'https://hyena.test/api/v1/apps'
const multipart = (fields: [string, string][]) => {
	const body = new FormData()
	for (const [key, value] of fields) body.append(key, value)
	return new Request(endpoint, { method: 'POST', body })
}

it('parses multipart text, arrays and nested fields using the same structure as URL-encoded forms', async () => {
	const fields: [string, string][] = [
		['client_name', 'Native app 🦊'],
		['redirect_uris[]', 'native://callback'],
		['redirect_uris[]', 'https://app.example/callback'],
		['subscription[keys][auth]', 'a+b=/'],
		['poll[options][]', 'First'],
		['poll[options][]', 'Second'],
	]
	const expected = {
		client_name: 'Native app 🦊',
		redirect_uris: ['native://callback', 'https://app.example/callback'],
		subscription: { keys: { auth: 'a+b=/' } },
		poll: { options: ['First', 'Second'] },
	}
	expect(await readInput(multipart(fields))).toEqual(expected)
	expect(await readInput(new Request(endpoint, { method: 'POST', body: new URLSearchParams(fields) }))).toEqual(
		expected
	)
})

it('preserves field validation for duplicate, conflicting and prototype-related multipart fields', async () => {
	for (const fields of [
		[
			['client_name', 'one'],
			['client_name', 'two'],
		],
		[
			['poll', 'one'],
			['poll[options][]', 'two'],
		],
		[['__proto__[polluted]', 'yes']],
		[['constructor[prototype][polluted]', 'yes']],
	] as [string, string][][]) {
		await expect(readInput(multipart(fields))).rejects.toMatchObject({ status: 400 })
	}
	expect(({} as Record<string, unknown>).polluted).toBeUndefined()
})

it('returns a client error for malformed multipart bodies and unexpected file parts', async () => {
	for (const contentType of ['multipart/form-data', 'multipart/form-data; boundary=missing']) {
		await expect(
			readInput(
				new Request(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': contentType },
					body: 'not a multipart body',
				})
			)
		).rejects.toMatchObject({ status: 400 })
	}
	const form = new FormData()
	form.set('client_name', new File(['unexpected file'], 'name.txt', { type: 'text/plain' }))
	await expect(readInput(new Request(endpoint, { method: 'POST', body: form }))).rejects.toMatchObject({ status: 400 })
})

it('enforces the body byte limit before parsing multipart, including streamed requests without Content-Length', async () => {
	const source = multipart([['client_name', 'x'.repeat(1024)]])
	const streamed = new Request(endpoint, { method: 'POST', headers: source.headers, body: source.body })
	expect(streamed.headers.has('content-length')).toBe(false)
	await expect(readInput(streamed, 128)).rejects.toMatchObject({ status: 413 })
})
