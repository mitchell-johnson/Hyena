import { ipPolicy, canonicalEmail } from './moderation-policy'
import { Hono } from 'hono'
import { authenticate } from './auth/access'
import { digest, passwordHash, randomToken } from './auth/crypto'
import { nextId } from './db'
import { accountById, all, one, run, parsed, now, object, setting } from './data'
import { ApiError, boolField, escapeHtml, readInput, stringField, throttle } from './http'
import { accountJSON, mediaJSON } from './serializers'
import { attributes } from './organize'
import { processMedia } from './media/process'
import { storeStream } from './media/storage'
import type { AccountRow, AppEnv, Env, MediaRow } from './types'

export const profile = new Hono<AppEnv>()
export const defaultPreferences = {
	'posting:default:visibility': 'public',
	'posting:default:sensitive': false,
	'posting:default:language': null,
	'reading:expand:media': 'default',
	'reading:expand:spoilers': false,
}
profile.get('/api/v1/preferences', async (c) => {
	await authenticate(c, 'read:accounts')
	const stored = parsed<Record<string, unknown>>(c.get('account').preferences, {})
	return c.json(Object.fromEntries(Object.entries(defaultPreferences).map(([k, v]) => [k, stored[k] ?? v])))
})
async function profileInput(request: Request) {
	if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return readInput(request)
	const limit = 8_000_000
	if (Number(request.headers.get('content-length')) > limit) throw new ApiError(413, 'Profile upload is too large')
	let size = 0
	const bounded = request.body!.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					size += chunk.byteLength
					if (size > limit) throw new ApiError(413, 'Profile upload is too large')
					controller.enqueue(chunk)
				},
			})
		),
		form = await new Request(request.url, {
			method: 'POST',
			headers: request.headers,
			body: bounded,
			duplex: 'half',
		} as RequestInit).formData(),
		input: Record<string, unknown> = {},
		params = new URLSearchParams()
	for (const [key, value] of form.entries()) {
		if (value instanceof File) {
			if (!['avatar', 'header'].includes(key) || input[key]) throw new ApiError(422, 'Unexpected profile upload')
			input[key] = value
		} else params.append(key, value)
	}
	return { ...(await readInput(new Request(request.url, { method: 'POST', body: params }))), ...input }
}
async function profileMedia(env: Env, account: string, file: File) {
	if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2_000_000 || !file.size)
		throw new ApiError(422, 'Use a JPEG, PNG or WebP image under 2 MB')
	const id = await nextId(env.DB),
		key = `original/${randomToken()}/upload`
	await run(
		env,
		"INSERT INTO media_attachments(id,account_id,state,original_key,mime_type,media_type,bytes,created_at,updated_at) VALUES(?,?,'uploaded',?,?,'image',?,?,?)",
		id,
		account,
		key,
		file.type,
		file.size,
		Date.now(),
		Date.now()
	)
	try {
		await storeStream(env.MEDIA_BUCKET, key, file.stream(), file.type, 2_000_000)
		await processMedia(env, id)
	} catch (error) {
		await run(env, "UPDATE media_attachments SET state='failed',error='Profile processing failed' WHERE id=?", id)
		throw error
	}
	const m = (await one<MediaRow>(env, 'SELECT * FROM media_attachments WHERE id=?', id))!
	return { id, url: mediaJSON(env, m).url! }
}
async function updateProfile(env: Env, a: AccountRow, input: Record<string, unknown>) {
	const allowed = new Set([
		'display_name',
		'note',
		'locked',
		'bot',
		'discoverable',
		'indexable',
		'hide_collections',
		'source',
		'fields_attributes',
		'fields',
		'avatar',
		'header',
		'avatar_description',
		'header_description',
		'show_media',
		'show_media_replies',
		'show_featured',
		'attribution_domains',
	])
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw new ApiError(422, 'Unknown profile field: ' + key)
	const display = stringField(input, 'display_name', a.display_name),
		raw = stringField(input, 'note', String(parsed<Record<string, unknown>>(a.preferences, {}).note_raw ?? a.note))
	if ([...display].length > 30 || [...raw].length > 500)
		throw new ApiError(422, 'Profile name or biography is too long')
	const prefs = parsed<Record<string, unknown>>(a.preferences, {})
	prefs.note_raw = raw
	const source = input.source === undefined ? {} : object(input.source)
	if (source.privacy !== undefined) {
		if (!['public', 'unlisted', 'private', 'direct'].includes(String(source.privacy)))
			throw new ApiError(422, 'Invalid default visibility')
		prefs['posting:default:visibility'] = source.privacy
	}
	if (source.sensitive !== undefined) prefs['posting:default:sensitive'] = boolField(source, 'sensitive')
	if (source.language !== undefined) prefs['posting:default:language'] = source.language || null
	for (const k of ['hide_collections', 'show_media', 'show_media_replies', 'show_featured'])
		if (input[k] !== undefined) prefs[k] = boolField(input, k)
	for (const k of ['avatar_description', 'header_description'])
		if (input[k] !== undefined) prefs[k] = stringField(input, k).slice(0, 1500)
	if (input.attribution_domains !== undefined) {
		if (
			!Array.isArray(input.attribution_domains) ||
			input.attribution_domains.length > 10 ||
			input.attribution_domains.some((x) => typeof x !== 'string' || !/^[a-z0-9.-]+$/i.test(x))
		)
			throw new ApiError(422, 'Invalid attribution domains')
		prefs.attribution_domains = input.attribution_domains
	}
	const fields =
		input.fields_attributes === undefined && input.fields === undefined
			? parsed<{ name: string; value: string }[]>(a.fields, [])
			: attributes(input.fields_attributes ?? input.fields)
					.filter((f) => !boolField(f, '_destroy'))
					.map((f) => ({ name: stringField(f, 'name'), value: stringField(f, 'value') }))
	if (fields.length > 4 || fields.some((f) => f.name.length > 255 || f.value.length > 255))
		throw new ApiError(422, 'Use up to four profile fields of 255 characters')
	const sets = [
			'display_name=?',
			'note=?',
			'locked=?',
			'bot=?',
			'discoverable=?',
			'indexable=?',
			'fields=?',
			'preferences=?',
		],
		values: (string | number | null)[] = [
			display,
			raw ? '<p>' + escapeHtml(raw).replace(/\n/g, '<br>') + '</p>' : '',
			+boolField(input, 'locked', !!a.locked),
			+boolField(input, 'bot', !!a.bot),
			+boolField(input, 'discoverable', !!a.discoverable),
			+boolField(input, 'indexable', !!a.indexable),
			JSON.stringify(fields.map((f) => ({ ...f, value: escapeHtml(f.value), verified_at: null }))),
			JSON.stringify(prefs),
		]
	for (const field of ['avatar', 'header'] as const)
		if (input[field] instanceof File) {
			const asset = await profileMedia(env, a.id, input[field])
			sets.push(field + '=?', field + '_media_id=?')
			values.push(asset.url, asset.id)
		}
	await env.DB.batch([
		env.DB.prepare(`UPDATE accounts SET ${sets.join(',')} WHERE id=? AND domain=''`).bind(...values, a.id),
		env.DB.prepare(`INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'account.event',?,?,?)`).bind(
			'account:' + crypto.randomUUID(),
			JSON.stringify({ accountId: a.id }),
			Date.now(),
			Date.now()
		),
	])
	return accountById(env, a.id)
}
async function profileJSON(env: Env, a: AccountRow) {
	const p = parsed<Record<string, unknown>>(a.preferences, {}),
		entity = await accountJSON(env, a, true)
	return {
		id: a.id,
		display_name: a.display_name,
		note: p.note_raw ?? a.note,
		formatted_note: a.note,
		fields: parsed(a.fields, []),
		formatted_fields: entity.fields,
		avatar: a.avatar ?? null,
		avatar_static: a.avatar ?? null,
		header: a.header ?? null,
		header_static: a.header ?? null,
		avatar_description: p.avatar_description ?? '',
		header_description: p.header_description ?? '',
		locked: !!a.locked,
		bot: !!a.bot,
		hide_collections: !!p.hide_collections,
		discoverable: !!a.discoverable,
		indexable: !!a.indexable,
		show_media: p.show_media ?? true,
		show_media_replies: p.show_media_replies ?? false,
		show_featured: p.show_featured ?? true,
		attribution_domains: p.attribution_domains ?? [],
		featured_tags: (
			await all<{ id: string; tag: string }>(
				env,
				"SELECT * FROM account_tags WHERE account_id=? AND kind='feature'",
				a.id
			)
		).map((t) => ({ id: t.id, name: t.tag })),
	}
}
profile.patch('/api/v1/accounts/update_credentials', async (c) => {
	await authenticate(c, 'write:accounts')
	return c.json(
		await accountJSON(c.env, await updateProfile(c.env, c.get('account'), await profileInput(c.req.raw)), true)
	)
})
profile.get('/api/v1/profile', async (c) => {
	await authenticate(c, 'read:accounts')
	return c.json(await profileJSON(c.env, c.get('account')))
})
profile.patch('/api/v1/profile', async (c) => {
	await authenticate(c, 'write:accounts')
	return c.json(await profileJSON(c.env, await updateProfile(c.env, c.get('account'), await profileInput(c.req.raw))))
})
for (const field of ['avatar', 'header'] as const)
	profile.delete('/api/v1/profile/' + field, async (c) => {
		await authenticate(c, 'write:accounts')
		await run(c.env, `UPDATE accounts SET ${field}=NULL,${field}_media_id=NULL WHERE id=?`, c.get('account').id)
		return c.json(await profileJSON(c.env, await accountById(c.env, c.get('account').id)))
	})

profile.post('/api/v1/accounts', async (c) => {
	const token = await authenticate(c, 'write:accounts', false)
	await throttle(c, 'registration')
	if (!c.env.EMAIL) throw new ApiError(503, 'Email delivery must be configured before opening registration')
	const input = await readInput(c.req.raw),
		username = stringField(input, 'username').toLowerCase(),
		password = stringField(input, 'password'),
		email = stringField(input, 'email').trim().toLowerCase()
	const inviteCode = stringField(input, 'invite_code'),
		invite = inviteCode
			? await one<{ code_hash: string; max_uses: number; uses: number }>(
					c.env,
					'SELECT * FROM invites WHERE code_hash=? AND expires_at>? AND uses<max_uses',
					await digest(inviteCode),
					Date.now()
				)
			: null,
		ipRule = await ipPolicy(c.env, c.req.header('CF-Connecting-IP'))
	if (!['open', 'approved'].includes(c.env.REGISTRATIONS ?? '') && !invite)
		throw new ApiError(403, 'Registrations are closed')
	if (inviteCode && !invite) throw new ApiError(422, 'Invitation expired or has no uses remaining')
	if (ipRule === 'sign_up_block' || ipRule === 'no_access')
		throw new ApiError(403, 'Registration is not available from this address')
	const reason = stringField(input, 'reason')
	if (reason.length > 1000 || (c.env.REGISTRATIONS === 'approved' && !reason.trim() && !invite))
		throw new ApiError(422, 'A reason for joining is required (up to 1000 characters)')
	const maximum = await setting(c.env, 'max_accounts', 10)
	if (
		!/^[a-z0-9_]{1,30}$/.test(username) ||
		password.length < 12 ||
		password.length > 256 ||
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
		email.length > 254 ||
		!boolField(input, 'agreement')
	)
		throw new ApiError(422, 'Invalid registration details')
	if (
		await one(
			c.env,
			"SELECT 1 FROM moderation_rules WHERE (kind='email_domain_blocks' AND value=?) OR (kind='canonical_email_blocks' AND value=?)",
			email.split('@')[1]!,
			await canonicalEmail(email)
		)
	)
		throw new ApiError(422, 'Email address is not allowed')
	if (await one(c.env, "SELECT 1 FROM accounts WHERE (username=? AND domain='') OR email=?", username, email))
		throw new ApiError(422, 'Username or email is already used')
	const id = await nextId(c.env.DB),
		raw = randomToken(),
		confirmation = randomToken()
	try {
		await c.env.DB.batch([
			c.env.DB.prepare(
				"INSERT INTO transaction_guards VALUES(?,CASE WHEN (SELECT COUNT(*) FROM accounts WHERE domain='' AND disabled=0)<? THEN 1 ELSE 0 END)"
			).bind('signup:' + id, maximum),
			...(invite
				? [
						c.env.DB.prepare(
							'INSERT INTO transaction_guards VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM invites WHERE code_hash=? AND expires_at>? AND uses<max_uses) THEN 1 ELSE 0 END)'
						).bind('invite:' + id, invite.code_hash, Date.now()),
						c.env.DB.prepare('UPDATE invites SET uses=uses+1 WHERE code_hash=?').bind(invite.code_hash),
					]
				: []),
			c.env.DB.prepare(
				'INSERT INTO accounts(id,username,password_hash,created_at,email,email_confirmed,approved,created_by_application_id,signup_ip,signup_reason) VALUES(?,?,?,?,?,0,?,?,?,?)'
			).bind(
				id,
				username,
				passwordHash(password),
				now(),
				email,
				+(ipRule !== 'sign_up_requires_approval' && (!!invite || c.env.REGISTRATIONS !== 'approved')),
				token.app_id,
				c.req.header('CF-Connecting-IP') ?? null,
				reason
			),
			c.env.DB.prepare(
				'INSERT INTO oauth_tokens(token_hash,app_id,account_id,scopes,created_at) VALUES(?,?,?,?,?)'
			).bind(await digest(raw), token.app_id, id, token.scopes, Date.now()),
			c.env.DB.prepare(
				"INSERT INTO email_tokens(hash,account_id,purpose,expires_at,email) VALUES(?,?,'confirm',?,?)"
			).bind(await digest(confirmation), id, Date.now() + 86400000, email),
			c.env.DB.prepare(`INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'email.send',?,?,?)`).bind(
				'email:' + crypto.randomUUID(),
				JSON.stringify({
					to: email,
					subject: 'Confirm your Hyena email',
					text: `Confirm your email: ${c.env.PUBLIC_ORIGIN}/auth/confirmation?token=${confirmation}`,
				}),
				Date.now(),
				Date.now()
			),
			c.env.DB.prepare('DELETE FROM transaction_guards WHERE id IN (?,?)').bind('signup:' + id, 'invite:' + id),
		])
	} catch (error) {
		if (String(error).includes('CHECK constraint failed'))
			throw new ApiError(422, 'The instance is full or this invitation has been used')
		throw error
	}
	return c.json({
		access_token: raw,
		token_type: 'Bearer',
		scope: token.scopes,
		created_at: Math.floor(Date.now() / 1000),
	})
})
profile.post('/api/v1/emails/confirmations', async (c) => {
	const appToken = await authenticate(c, 'write:accounts')
	if (c.get('account').email_confirmed || c.get('account').created_by_application_id !== appToken.app_id)
		throw new ApiError(403, 'Only the registering application can confirm an unconfirmed account')
	if (!c.env.EMAIL) throw new ApiError(503, 'Email delivery is not configured')
	const input = await readInput(c.req.raw),
		a = c.get('account'),
		email = stringField(input, 'email', a.email ?? '')
			.trim()
			.toLowerCase()
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, 'Invalid email')
	const token = randomToken()
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM email_tokens WHERE account_id=? AND purpose='confirm'").bind(a.id),
		c.env.DB.prepare('UPDATE accounts SET email=?,email_confirmed=0 WHERE id=?').bind(email, a.id),
		c.env.DB.prepare(
			"INSERT INTO email_tokens(hash,account_id,purpose,expires_at,email) VALUES(?,?,'confirm',?,?)"
		).bind(await digest(token), a.id, Date.now() + 86400000, email),
		c.env.DB.prepare(`INSERT INTO jobs(id,kind,payload,available_at,created_at) VALUES(?,'email.send',?,?,?)`).bind(
			'email:' + crypto.randomUUID(),
			JSON.stringify({
				to: email,
				subject: 'Confirm your Hyena email',
				text: `Confirm your email: ${c.env.PUBLIC_ORIGIN}/auth/confirmation?token=${token}`,
			}),
			Date.now(),
			Date.now()
		),
	])
	return c.json({})
})
profile.get('/api/v1/emails/check_confirmation', async (c) => {
	await authenticate(c, 'read:accounts')
	return c.json(!!c.get('account').email_confirmed)
})
profile.get('/auth/confirmation', async (c) => {
	const hash = await digest(c.req.query('token') ?? ''),
		entry = await one<{ account_id: string }>(
			c.env,
			"SELECT account_id FROM email_tokens WHERE hash=? AND purpose='confirm' AND expires_at>? AND email=(SELECT email FROM accounts WHERE id=email_tokens.account_id)",
			hash,
			Date.now()
		)
	if (!entry) throw new ApiError(422, 'Invalid or expired confirmation')
	await c.env.DB.batch([
		c.env.DB.prepare(
			'UPDATE accounts SET email_confirmed=1 WHERE id=? AND EXISTS(SELECT 1 FROM email_tokens WHERE hash=? AND account_id=accounts.id AND email=accounts.email AND expires_at>?)'
		).bind(entry.account_id, hash, Date.now()),
		c.env.DB.prepare('DELETE FROM email_tokens WHERE hash=?').bind(hash),
	])
	return c.redirect('/login', 303)
})
profile.post('/api/v1/accounts/:id/email_subscriptions', async (c) => {
	await authenticate(c, 'write:accounts')
	const target = await accountById(c.env, c.req.param('id')),
		input = await readInput(c.req.raw),
		value = boolField(input, 'subscribe', true)
	if (value)
		await run(
			c.env,
			"INSERT OR IGNORE INTO account_actions(id,account_id,target_id,kind,created_at) VALUES(?,?,?,'email_subscription',?)",
			await nextId(c.env.DB),
			c.get('account').id,
			target.id,
			now()
		)
	else
		await run(
			c.env,
			"DELETE FROM account_actions WHERE account_id=? AND target_id=? AND kind='email_subscription'",
			c.get('account').id,
			target.id
		)
	return c.json({ subscribed: value })
})
export async function sendEmail(env: Env, payload: { to: string; subject: string; text: string }) {
	if (!env.EMAIL || !env.CONTACT_EMAIL) throw new Error('Email delivery is not configured')
	if (/[\r\n]/.test(payload.to + payload.subject + env.CONTACT_EMAIL)) throw new ApiError(422, 'Invalid email headers')
	await env.EMAIL.send({ from: env.CONTACT_EMAIL, to: payload.to, subject: payload.subject, text: payload.text })
}
