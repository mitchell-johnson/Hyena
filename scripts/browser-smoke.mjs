// Creates and posts using a disposable local account. Start the local server first.
import { mkdirSync, writeFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = process.env.HYENA_TEST_ORIGIN || 'http://localhost:8787'
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
	throw Error('Run the smoke test against a disposable local server')
const username = process.env.HYENA_TEST_USERNAME,
	password = process.env.HYENA_TEST_PASSWORD
if (!username || !password) throw Error('Set HYENA_TEST_USERNAME and HYENA_TEST_PASSWORD for the local test account')
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_EXECUTABLE,
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
	errors = [],
	failures = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('response', (r) => {
	if (r.status() >= 500) failures.push({ url: new URL(r.url()).pathname, status: r.status() })
})
await page.goto(origin + '/setup')
if (new URL(page.url()).pathname === '/setup') {
	await page.locator('[name=setup_token]').fill(process.env.HYENA_TEST_SETUP_TOKEN || '')
	await page.locator('[name=username]').fill(username)
	await page.locator('[name=password]').fill(password)
	await page.getByRole('button', { name: 'Create account', exact: true }).click()
}
await page.waitForURL('**/login')
await page.locator('[name=username]').fill(username)
await page.locator('[name=password]').fill(password)
await page.getByRole('button', { name: 'Sign in', exact: true }).click()
await page.waitForURL(origin + '/')
await page.locator('#post-text').fill('Browser smoke test: a complete post with #hyena.')
await page.getByRole('button', { name: 'Post', exact: true }).click()
await page.locator('#view .post').first().waitFor()
const id = await page.locator('#view .post').first().getAttribute('data-id')
const owner = await page.evaluate(async () => (await (await fetch('/api/hyena/session')).json()).account.id)
const routes = [
	'/public',
	'/notifications',
	'/conversations',
	'/bookmarks',
	'/favourites',
	'/lists',
	'/collections',
	'/scheduled_statuses',
	'/explore',
	'/search',
	'/settings',
	'/settings/apps',
	'/admin',
	'/annual_reports',
	'/accounts/' + owner,
	'/statuses/' + id,
]
const visited = []
for (const path of routes) {
	await page.goto(origin + path)
	await page.locator('#view[aria-busy=false]').waitFor()
	const message = await page.locator('#message').textContent()
	visited.push({ path, message })
	if (await page.locator('#message.error').count()) failures.push({ path, message })
}
await page.goto(origin + '/settings')
await page.locator('#view[aria-busy=false]').waitFor()
for (const name of [
	'Preferences',
	'Security',
	'Blocks and mutes',
	'Filters',
	'Hashtags',
	'Import and export',
	'Account',
]) {
	await page.getByRole('button', { name, exact: true }).click()
	await page.waitForTimeout(150)
	if (await page.locator('#message.error').count())
		failures.push({ tab: name, message: await page.locator('#message').textContent() })
}
await page.goto(origin + '/')
await page.locator('#view[aria-busy=false]').waitFor()
mkdirSync('test-results', { recursive: true })
await page.screenshot({ path: 'test-results/desktop.png', fullPage: true })
await page.setViewportSize({ width: 390, height: 844 })
await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
const report = { browser: browser.version(), routes: visited, errors, failures, mobileOverflow: overflow }
writeFileSync('test-results/browser-smoke.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()
if (errors.length || failures.length || overflow) process.exitCode = 1
