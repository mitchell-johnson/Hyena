import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'

export default defineConfig({
	// Workers nodejs_compat supplies Node modules. Avoid browser:false stubs,
	// which Vitest otherwise misidentifies as the empty builtin `node:`.
	resolve: { mainFields: ['module', 'main'] },
	plugins: [
		cloudflareTest({
			main: './src/index.ts',
			remoteBindings: false,
			miniflare: {
				compatibilityDate: '2026-09-10',
				compatibilityFlags: ['nodejs_compat'],
				d1Databases: ['DB'],
				r2Buckets: ['MEDIA_BUCKET'],
				durableObjects: { STREAMS: { className: 'StreamHub', useSQLite: true } },
				queueProducers: { JOBS: 'hyena-test-jobs' },
				bindings: {
					PUBLIC_ORIGIN: 'https://hyena.test',
					INSTANCE_TITLE: 'Test Hyena',
					INSTANCE_DESCRIPTION: 'Integration test instance',
					MAX_MEDIA_BYTES: '40000000',
					SETUP_TOKEN: 'integration-test-only',
					TEST_MIGRATIONS: await readD1Migrations('./schema'),
					TEST_FILES: Object.fromEntries(
						['short.mp4', 'sixty-seconds.mp4', 'short.mp3'].map((name) => [
							name,
							readFileSync(`tests/fixtures/${name}`, { encoding: 'base64' }),
						])
					),
				},
			},
		}),
	],
	test: {
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: ['@fedify/fedify', '@fedify/vocab', '@fedify/hono', 'sanitize-html', '@simplewebauthn/server'],
					rolldownOptions: { external: [...builtinModules, /^node:/, /^cloudflare:/] },
				},
			},
		},
		include: ['tests/**/*.test.ts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		fileParallelism: false,
	},
})
