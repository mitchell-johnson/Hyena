import { Hono } from 'hono'
import { authenticate, optionalAccount } from './auth/access'
import { all, one, run, parsed, now, accountById, accountUri, list, cursors, pageLimit, links } from './data'
import { nextId } from './db'
import { ApiError, boolField, readInput, stringField, escapeHtml } from './http'
import { accountJSON } from './serializers'
import { blocked } from './policy'
import { outboundStatement } from './federation/outbox'
import { notificationStatements } from './notifications'
import type { AccountRow, AppEnv, Env } from './types'

export const collections = new Hono<AppEnv>()
export interface CollectionRow {
	id: string
	account_id: string
	name: string
	description: string
	uri: string | null
	discoverable: number
	created_at: string
	updated_at: string
	language: string | null
	sensitive: number
	tag: string | null
	deleted_at: string | null
}
export interface ItemRow {
	id: string
	collection_id: string
	account_id: string
	state: string
	authorization: string | null
	created_at: string
	request_uri: string | null
}
export const COLLECTION_CONTEXT = [
	'https://www.w3.org/ns/activitystreams',
	{
		FeaturedCollection: 'https://w3id.org/fep/7aa9#FeaturedCollection',
		FeaturedItem: 'https://w3id.org/fep/7aa9#FeaturedItem',
		FeatureRequest: 'https://w3id.org/fep/7aa9#FeatureRequest',
		FeatureAuthorization: 'https://w3id.org/fep/7aa9#FeatureAuthorization',
		featuredObject: { '@id': 'https://w3id.org/fep/7aa9#featuredObject', '@type': '@id' },
		featureAuthorization: { '@id': 'https://w3id.org/fep/7aa9#featureAuthorization', '@type': '@id' },
		interactingObject: { '@id': 'https://gotosocial.org/ns#interactingObject', '@type': '@id' },
		interactionTarget: { '@id': 'https://gotosocial.org/ns#interactionTarget', '@type': '@id' },
		featuredCollections: { '@id': 'https://w3id.org/fep/7aa9#featuredCollections', '@type': '@id' },
		discoverable: 'http://joinmastodon.org/ns#discoverable',
		sensitive: 'as:sensitive',
		topic: { '@id': 'https://w3id.org/fep/7aa9#topic', '@type': '@id' },
	},
]
export const collectionUri = (env: Env, c: CollectionRow) => c.uri || `${env.PUBLIC_ORIGIN}/collections/${c.id}`
export const itemUri = (env: Env, i: ItemRow) => `${env.PUBLIC_ORIGIN}/collections/${i.collection_id}/items/${i.id}`
export function itemJSON(i: ItemRow) {
	return {
		id: i.id,
		state: i.state,
		created_at: i.created_at,
		...(['accepted', 'pending'].includes(i.state) ? { account_id: i.account_id } : {}),
	}
}
export async function canFeature(env: Env, owner: AccountRow, target: AccountRow) {
	if (owner.suspended || target.suspended || (await blocked(env, owner.id, target.id))) return false
	if (!target.domain)
		return (
			!!target.discoverable &&
			(!target.locked ||
				target.id === owner.id ||
				!!(await one(
					env,
					"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
					owner.id,
					target.id
				)))
		)
	if (owner.id === target.id) return true
	const p = parsed<{ feature_policy?: { automaticApproval?: string[]; manualApproval?: string[] } }>(
			target.preferences,
			{}
		).feature_policy,
		values = [...(p?.automaticApproval ?? []), ...(p?.manualApproval ?? [])]
	for (const uri of values) {
		if (uri === 'https://www.w3.org/ns/activitystreams#Public' || uri === accountUri(env, owner)) return true
		if (
			uri === target.followers_url &&
			(await one(
				env,
				"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
				owner.id,
				target.id
			))
		)
			return true
		if (
			uri === target.following_url &&
			(await one(
				env,
				"SELECT 1 FROM follows WHERE follower_id=? AND following_id=? AND state='accepted'",
				target.id,
				owner.id
			))
		)
			return true
	}
	return false
}
export async function loadCollection(env: Env, id: string, viewer: string | null, owner = false) {
	const c = await one<CollectionRow>(env, 'SELECT * FROM collections WHERE id=? AND deleted_at IS NULL', id)
	if (
		!c ||
		(owner && c.account_id !== viewer) ||
		(viewer && (await blocked(env, c.account_id, viewer))) ||
		(await accountById(env, c.account_id)).suspended
	)
		throw new ApiError(404, 'Record not found')
	return c
}
export async function collectionJSON(env: Env, c: CollectionRow, viewer: string | null) {
	const owner = await accountById(env, c.account_id),
		rows = await all<ItemRow>(
			env,
			`SELECT i.* FROM collection_items i JOIN accounts a ON a.id=i.account_id WHERE i.collection_id=? AND i.state IN (${viewer === owner.id ? "'accepted','pending'" : "'accepted'"}) AND a.suspended=0 ORDER BY CAST(i.id AS INTEGER)`,
			c.id
		),
		items = []
	for (const i of rows) if (!viewer || !(await blocked(env, viewer, i.account_id))) items.push(itemJSON(i))
	return {
		id: c.id,
		uri: collectionUri(env, c),
		name: c.name,
		description: c.description,
		language: c.language,
		account_id: c.account_id,
		local: !owner.domain,
		sensitive: !!c.sensitive,
		discoverable: !!c.discoverable,
		url: collectionUri(env, c),
		item_count: items.length,
		created_at: c.created_at,
		updated_at: c.updated_at,
		tag: c.tag ? { name: c.tag, url: `${env.PUBLIC_ORIGIN}/tags/${encodeURIComponent(c.tag)}` } : null,
		items,
	}
}
export async function featuredItem(env: Env, i: ItemRow) {
	return {
		id: itemUri(env, i),
		type: 'FeaturedItem',
		featuredObject: accountUri(env, await accountById(env, i.account_id)),
		featureAuthorization: i.authorization,
		published: i.created_at,
	}
}
export async function featuredCollection(env: Env, c: CollectionRow) {
	const items = await all<ItemRow>(
		env,
		"SELECT i.* FROM collection_items i JOIN accounts a ON a.id=i.account_id WHERE collection_id=? AND state='accepted' AND a.suspended=0 ORDER BY CAST(i.id AS INTEGER)",
		c.id
	)
	return {
		'@context': COLLECTION_CONTEXT,
		id: collectionUri(env, c),
		type: 'FeaturedCollection',
		attributedTo: accountUri(env, await accountById(env, c.account_id)),
		name: c.name,
		summary: c.description,
		...(c.language ? { summaryMap: { [c.language]: c.description } } : {}),
		url: collectionUri(env, c),
		sensitive: !!c.sensitive,
		discoverable: !!c.discoverable,
		published: c.created_at,
		updated: c.updated_at,
		totalItems: items.length,
		orderedItems: await Promise.all(items.map((i) => featuredItem(env, i))),
		...(c.tag
			? {
					topic: { type: 'Hashtag', name: '#' + c.tag, href: `${env.PUBLIC_ORIGIN}/tags/${encodeURIComponent(c.tag)}` },
				}
			: {}),
	}
}
export async function collectionRecipients(env: Env, c: CollectionRow) {
	return (
		await all<{ id: string }>(
			env,
			"SELECT follower_id id FROM follows WHERE following_id=? AND state='accepted' UNION SELECT account_id id FROM collection_items WHERE collection_id=? AND state='accepted'",
			c.account_id,
			c.id
		)
	).map((r) => r.id)
}
export async function collectionChanged(env: Env, c: CollectionRow, type = 'Update') {
	const a = await accountById(env, c.account_id)
	return outboundStatement(
		env,
		a.id,
		{
			'@context': COLLECTION_CONTEXT,
			type,
			actor: accountUri(env, a),
			object: type === 'Delete' ? { id: collectionUri(env, c), type: 'Tombstone' } : await featuredCollection(env, c),
		},
		await collectionRecipients(env, c)
	)
}
export async function addItemStatements(env: Env, c: CollectionRow, owner: AccountRow, target: AccountRow) {
	if (!(await canFeature(env, owner, target))) throw new ApiError(422, 'This account cannot be added to collections')
	if (
		await one(
			env,
			"SELECT 1 FROM collection_items WHERE collection_id=? AND account_id=? AND state IN ('pending','accepted')",
			c.id,
			target.id
		)
	)
		throw new ApiError(422, 'This account is already in the collection')
	const id = await nextId(env.DB),
		request = `${env.PUBLIC_ORIGIN}/activities/feature-${id}`,
		authorization = target.domain ? null : `${env.PUBLIC_ORIGIN}/feature_authorizations/${id}`,
		i: ItemRow = {
			id,
			collection_id: c.id,
			account_id: target.id,
			state: target.domain ? 'pending' : 'accepted',
			authorization,
			request_uri: request,
			created_at: now(),
		},
		statements = [
			env.DB.prepare(
				`INSERT INTO collection_items(id,collection_id,account_id,state,authorization,created_at,request_uri) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM collection_items WHERE collection_id=? AND state IN ('pending','accepted'))<25 ON CONFLICT(collection_id,account_id) DO UPDATE SET state=excluded.state,authorization=excluded.authorization,request_uri=excluded.request_uri`
			).bind(id, c.id, target.id, i.state, authorization, i.created_at, request, c.id),
		]
	if (target.domain)
		statements.push(
			outboundStatement(
				env,
				owner.id,
				{
					'@context': COLLECTION_CONTEXT,
					id: request,
					type: 'FeatureRequest',
					actor: accountUri(env, owner),
					object: accountUri(env, target),
					instrument: collectionUri(env, c),
				},
				[target.id],
				`feature-${id}`
			)
		)
	else
		statements.push(
			...(await notificationStatements(env, target.id, owner.id, 'added_to_collection', null, 'collection-item:' + id))
		)
	statements.push(
		env.DB.prepare('UPDATE notifications SET collection_id=? WHERE event_key=?').bind(c.id, 'collection-item:' + id)
	)
	return { i, statements }
}
for (const prefix of ['/api/v1', '/api/v1_alpha']) {
	if (prefix.endsWith('alpha'))
		collections.use(prefix + '/*', async (c, next) => {
			c.header('Deprecation', '@1781049600')
			await next()
		})
	for (const reverse of [false, true])
		collections.get(prefix + '/accounts/:id/' + (reverse ? 'in_collections' : 'collections'), async (c) => {
			const viewer = await optionalAccount(c),
				target = await accountById(c.env, c.req.param('id')!)
			if (reverse && viewer !== target.id) throw new ApiError(403, 'Only the account owner may list memberships')
			if (viewer && (await blocked(c.env, viewer, target.id))) return c.json({ collections: [] })
			const cur = cursors(c, 'c.id'),
				rows = await all<CollectionRow>(
					c.env,
					`SELECT c.* FROM collections c JOIN accounts a ON a.id=c.account_id WHERE c.deleted_at IS NULL AND a.suspended=0 AND ${reverse ? "EXISTS(SELECT 1 FROM collection_items i WHERE i.collection_id=c.id AND i.account_id=? AND i.state='accepted')" : 'c.account_id=?'} ${cur.sql} ORDER BY CAST(c.id AS INTEGER) ${cur.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
					target.id,
					...cur.binds,
					pageLimit(c, 100)
				)
			if (cur.ascending) rows.reverse()
			links(c, rows)
			return c.json({ collections: await Promise.all(rows.map((r) => collectionJSON(c.env, r, viewer))) })
		})
	collections.get(prefix + '/collections/:id', async (c) => {
		const viewer = await optionalAccount(c),
			row = await loadCollection(c.env, c.req.param('id')!, viewer),
			collection = await collectionJSON(c.env, row, viewer),
			ids = [
				...new Set([row.account_id, ...collection.items.map((i) => i.account_id).filter((id): id is string => !!id)]),
			]
		return c.json({
			collection,
			accounts: await Promise.all(ids.map(async (id) => accountJSON(c.env, await accountById(c.env, id)))),
		})
	})
	for (const method of ['post', 'put'] as const)
		collections[method](prefix + '/collections' + (method === 'put' ? '/:id' : ''), async (c) => {
			await authenticate(c, 'write:collections')
			const a = c.get('account'),
				old = method === 'put' ? await loadCollection(c.env, c.req.param('id')!, a.id, true) : null,
				input = await readInput(c.req.raw),
				name = stringField(input, 'name', old?.name ?? '').trim(),
				description = stringField(input, 'description', old?.description ?? ''),
				language = stringField(input, 'language', old?.language ?? '') || null,
				tag =
					stringField(input, 'tag_name', old?.tag ?? '')
						.replace(/^#/, '')
						.normalize('NFKC')
						.toLowerCase() || null
			if (
				!name ||
				name.length > 40 ||
				description.length > 100 ||
				(language && !/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language)) ||
				(tag && !/^[\p{L}\p{N}_]+$/u.test(tag))
			)
				throw new ApiError(422, 'Invalid collection fields')
			if (
				!old &&
				(await one<{ n: number }>(
					c.env,
					'SELECT COUNT(*) n FROM collections WHERE account_id=? AND deleted_at IS NULL',
					a.id
				))!.n >= 10
			)
				throw new ApiError(422, 'Maximum ten collections')
			const row: CollectionRow = {
					id: old?.id ?? (await nextId(c.env.DB)),
					account_id: a.id,
					name,
					description,
					language,
					tag,
					uri: null,
					sensitive: +boolField(input, 'sensitive', !!old?.sensitive),
					discoverable: +boolField(input, 'discoverable', !!old?.discoverable),
					created_at: old?.created_at ?? now(),
					updated_at: now(),
					deleted_at: null,
				},
				ids = list(input.account_ids, 25),
				statements = [
					c.env.DB.prepare(
						'INSERT INTO collections(id,account_id,name,description,language,tag,sensitive,discoverable,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,language=excluded.language,tag=excluded.tag,sensitive=excluded.sensitive,discoverable=excluded.discoverable,updated_at=excluded.updated_at'
					).bind(
						row.id,
						a.id,
						name,
						row.description,
						language,
						tag,
						row.sensitive,
						row.discoverable,
						row.created_at,
						row.updated_at
					),
				]
			for (const id of ids)
				statements.push(...(await addItemStatements(c.env, row, a, await accountById(c.env, id))).statements)
			await c.env.DB.batch(statements)
			await (await collectionChanged(c.env, row)).run()
			if (old && (old.name !== name || old.description !== row.description))
				for (const i of await all<ItemRow>(
					c.env,
					"SELECT * FROM collection_items WHERE collection_id=? AND state='accepted'",
					row.id
				))
					await c.env.DB.batch(
						await notificationStatements(
							c.env,
							i.account_id,
							a.id,
							'collection_update',
							null,
							'collection-update:' + row.id + ':' + row.updated_at + ':' + i.account_id,
							undefined,
							row.id
						)
					)
			return c.json({ collection: await collectionJSON(c.env, row, a.id) })
		})
	collections.delete(prefix + '/collections/:id', async (c) => {
		await authenticate(c, 'write:collections')
		const row = await loadCollection(c.env, c.req.param('id')!, c.get('account').id, true)
		await c.env.DB.batch([
			c.env.DB.prepare('UPDATE collections SET deleted_at=? WHERE id=?').bind(now(), row.id),
			await collectionChanged(c.env, row, 'Delete'),
		])
		return c.json({})
	})
	collections.post(prefix + '/collections/:id/items', async (c) => {
		await authenticate(c, 'write:collections')
		const a = c.get('account'),
			row = await loadCollection(c.env, c.req.param('id')!, a.id, true),
			input = await readInput(c.req.raw),
			target = await accountById(c.env, stringField(input, 'account_id')),
			item = await addItemStatements(c.env, row, a, target),
			results = await c.env.DB.batch(item.statements)
		if (!results[0]?.meta.changes) throw new ApiError(422, 'Maximum 25 collection items')
		await (await collectionChanged(c.env, row)).run()
		return c.json({
			collection_item: itemJSON(
				(await one<ItemRow>(
					c.env,
					'SELECT * FROM collection_items WHERE collection_id=? AND account_id=?',
					row.id,
					target.id
				))!
			),
		})
	})
	for (const revoke of [false, true])
		collections[revoke ? 'post' : 'delete'](
			prefix + '/collections/:id/items/:item' + (revoke ? '/revoke' : ''),
			async (c) => {
				await authenticate(c, 'write:collections')
				const a = c.get('account'),
					row = await loadCollection(c.env, c.req.param('id')!, a.id, !revoke),
					i = await one<ItemRow>(
						c.env,
						'SELECT * FROM collection_items WHERE id=? AND collection_id=?',
						c.req.param('item')!,
						row.id
					)
				if (!i || (revoke && i.account_id !== a.id)) throw new ApiError(404, 'Record not found')
				const statements = [
					c.env.DB.prepare('UPDATE collection_items SET state=? WHERE id=?').bind(
						revoke ? 'revoked' : 'rejected',
						i.id
					),
				]
				if (revoke && i.authorization)
					statements.push(
						outboundStatement(
							c.env,
							a.id,
							{
								'@context': COLLECTION_CONTEXT,
								type: 'Delete',
								actor: accountUri(c.env, a),
								object: { id: i.authorization, type: 'FeatureAuthorization' },
							},
							[row.account_id, ...(await collectionRecipients(c.env, row))]
						)
					)
				else
					statements.push(
						outboundStatement(
							c.env,
							a.id,
							{
								'@context': COLLECTION_CONTEXT,
								type: 'Remove',
								actor: accountUri(c.env, a),
								target: collectionUri(c.env, row),
								object: itemUri(c.env, i),
							},
							await collectionRecipients(c.env, row)
						)
					)
				await c.env.DB.batch(statements)
				return c.json({})
			}
		)
}
