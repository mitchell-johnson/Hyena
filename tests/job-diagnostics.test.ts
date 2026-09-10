import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { SendActivityError } from '@fedify/fedify'
import { env, runtime } from './support'
import { executeJob, jobErrorDiagnostic } from '../src/jobs'
import { one } from '../src/data'
import type { Env, JobRow } from '../src/types'

beforeEach(async () => applyD1Migrations(env.DB, runtime.TEST_MIGRATIONS))
afterEach(async () => {
	vi.restoreAllMocks()
	await reset()
})

it('records failure status and callsites without response bodies, URLs, headers or nested secrets', () => {
	const error = new SendActivityError(
			new URL('https://remote.example/inbox?token=secret-url'),
			403,
			'Private activity secret-message',
			'private response secret-body',
			new Headers({ Authorization: 'Bearer secret-header' })
		),
		cause = Object.assign(new TypeError('secret-cause'), { code: 'ECONNRESET' })
	error.cause = cause
	error.stack =
		'SendActivityError: secret-message\nsecret-body\n    at async sendActivity (https://remote.example/private/index.js:23:45)\n    at executeJob (worker.js:67:89)'
	cause.stack = 'TypeError: secret-cause\n    at fetch (node.js:1:2)'
	const result = jobErrorDiagnostic(error)
	expect(result).toEqual({
		type: 'SendActivityError',
		status: 403,
		frames: [
			{ file: 'index.js', line: 23, column: 45, function: 'sendActivity' },
			{ file: 'worker.js', line: 67, column: 89, function: 'executeJob' },
		],
		cause: {
			type: 'TypeError',
			code: 'ECONNRESET',
			frames: [{ file: 'node.js', line: 1, column: 2, function: 'fetch' }],
		},
	})
	expect(JSON.stringify(result)).not.toMatch(/secret|remote\.example|private|Bearer/)
	cause.cause = error
	expect(() => JSON.stringify(jobErrorDiagnostic(error))).not.toThrow()
})

it('emits a structured diagnostic when a durable job fails and retains its retry', async () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {}),
		time = Date.now(),
		error = Object.assign(new Error('private mail body and secret-token'), { name: 'ProviderError', statusCode: 503 })
	await env.DB.prepare(
		"INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES('diagnostic-job','email.send',?,?,?)"
	)
		.bind(
			JSON.stringify({ to: 'private-recipient@example.net', subject: 'secret-subject', text: 'secret-body' }),
			time,
			time
		)
		.run()
	await executeJob(
		{
			...env,
			CONTACT_EMAIL: 'admin@hyena.test',
			EMAIL: {
				send: async () => {
					throw error
				},
			} as unknown as Env['EMAIL'],
		},
		'diagnostic-job'
	)
	expect(log).toHaveBeenCalledTimes(1)
	const diagnostic = JSON.parse(String(log.mock.calls[0]![0]))
	expect(diagnostic).toMatchObject({
		event: 'job_failed',
		jobId: 'diagnostic-job',
		kind: 'email.send',
		attempt: 1,
		terminal: false,
		error: { type: 'ProviderError', status: 503 },
	})
	expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private-recipient|private mail/)
	expect(await one<JobRow>(env, "SELECT * FROM jobs WHERE id='diagnostic-job'")).toMatchObject({
		state: 'pending',
		attempt: 1,
	})
})
