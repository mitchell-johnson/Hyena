import { state, esc, api, post, bind, button, message, sleep } from './api.js'
export function composer(root, onPosted, { reply, quote, edit, source } = {}) {
	root.hidden = false
	let idempotencyKey = crypto.randomUUID(),
		submitted = null
	const attached = (edit?.media_attachments ?? []).map((m) => ({ ...m }))
	root.innerHTML = `<form class="panel"><h2>${edit ? 'Edit post' : reply ? 'Reply to @' + esc(reply.account.acct) : quote ? 'Quote @' + esc(quote.account.acct) : 'What’s on your mind?'}</h2><label class="muted" for="post-text">Your post <span class="count" id="post-count"></span></label><textarea id="post-text" name="status" maxlength="5000" placeholder="A thought, a question, a small discovery…">${esc(source?.text ?? (reply ? '@' + reply.account.acct + ' ' : ''))}</textarea><details ${edit?.spoiler_text ? 'open' : ''}><summary>Content warning</summary><input name="spoiler_text" maxlength="500" placeholder="Describe what’s behind the warning" value="${esc(source?.spoiler_text ?? '')}"><label><input type="checkbox" name="sensitive" ${edit?.sensitive ? 'checked' : ''}> Mark media sensitive</label></details><div class="row"><label>Audience<select name="visibility"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Followers</option><option value="direct">Mentioned people</option></select></label><label>Language <input name="language" maxlength="8" value="${esc(edit?.language ?? navigator.language.split('-')[0])}"></label></div><label class="muted">Attach media (up to four; shorter than 60 seconds)<input type="file" multiple id="upload" accept="${esc(state.instance?.configuration?.media_attachments?.supported_mime_types?.join(',') ?? 'image/*,video/mp4,audio/mpeg')}"></label><div id="attached"></div><details><summary>Poll, schedule and quote options</summary><label>Poll options, one per line<textarea name="poll" placeholder="First option&#10;Second option"></textarea></label><label>Poll duration<select name="expires"><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">1 week</option></select></label><label><input type="checkbox" name="multiple"> Allow multiple choices</label><label><input type="checkbox" name="hide_totals"> Hide totals until voting</label>${edit ? '' : '<label>Schedule for <input name="scheduled_at" type="datetime-local"></label>'}<label>Who can quote?<select name="quote_approval_policy"><option value="public">Everyone</option><option value="followers">Followers</option><option value="nobody">Nobody</option></select></label></details><div class="row"><button class="primary" type="submit">${edit ? 'Save changes' : 'Post'}</button><button class="quiet" type="button" id="cancel-compose">Clear</button></div></form>`
	const form = root.querySelector('form'),
		select = form.elements.visibility
	select.value = edit?.visibility ?? reply?.visibility ?? state.account?.source?.privacy ?? 'public'
	if (edit) {
		select.disabled = true
		form.elements.poll.value = edit.poll?.options.map((o) => o.title).join('\n') ?? ''
		form.elements.multiple.checked = !!edit.poll?.multiple
	}
	form.elements.quote_approval_policy.value = edit
		? edit.quote_approval?.automatic.includes('public')
			? 'public'
			: edit.quote_approval?.automatic.includes('followers')
				? 'followers'
				: 'nobody'
		: 'public'
	let pollDurationChanged = !edit
	form.elements.expires.addEventListener('change', () => {
		pollDurationChanged = true
	})
	form.querySelector('#cancel-compose').onclick = () => composer(root, onPosted)
	const text = form.elements.status,
		count = form.querySelector('#post-count')
	const update = () => {
		const weighted = text.value
			.replace(/https?:\/\/[^\s<>]+/g, 'x'.repeat(23))
			.replace(/@([A-Za-z0-9_]+)@[A-Za-z0-9.-]+/g, '@$1')
		count.textContent = [...new Intl.Segmenter().segment(weighted)].length + ' / 500'
	}
	text.addEventListener('input', update)
	update()
	let uploading = false
	const renderMedia = () => {
		const list = form.querySelector('#attached')
		list.innerHTML = ''
		for (const m of attached) {
			const div = document.createElement('div')
			div.innerHTML = `${m.preview_url ? `<img class="preview" src="${esc(m.preview_url)}" alt="">` : ''}<label>Media description<input value="${esc(m.description ?? '')}" maxlength="1500"></label>`
			div.querySelector('input').addEventListener('change', async (e) => {
				try {
					m.description = e.target.value
					if (!edit) await api('/api/v1/media/' + m.id, { method: 'PUT', body: { description: m.description } })
				} catch (error) {
					message(error.message, true)
				}
			})
			div.append(
				button(
					'Remove attachment',
					() => {
						attached.splice(attached.indexOf(m), 1)
						renderMedia()
					},
					'quiet'
				)
			)
			list.append(div)
		}
	}
	renderMedia()
	form.querySelector('#upload').addEventListener('change', async (e) => {
		uploading = true
		try {
			for (const file of e.target.files) {
				if (attached.length >= 4) throw new Error('A post can include up to four attachments.')
				const body = new FormData()
				body.set('file', file)
				const media = await api('/api/v2/media', { method: 'POST', body })
				message('Processing ' + file.name + '…')
				let ready = null
				for (let n = 0; n < 120 && !ready; n++) {
					await sleep(1000)
					ready = await api('/api/v1/media/' + media.id)
				}
				if (!ready) throw new Error('Media is still processing. Its upload ID is ' + media.id + '.')
				attached.push(ready)
				renderMedia()
			}
			message('Media ready. Add descriptions before posting.')
		} catch (error) {
			message(error.message, true)
		} finally {
			uploading = false
			e.target.value = ''
		}
	})
	bind(form, async (f) => {
		if (uploading) throw new Error('Wait for media processing to finish.')
		const body = {
			status: f.get('status'),
			spoiler_text: f.get('spoiler_text'),
			sensitive: f.has('sensitive'),
			visibility: edit?.visibility ?? f.get('visibility'),
			language: f.get('language') || undefined,
			media_ids: attached.map((m) => m.id),
			media_attributes: attached.map((m) => ({ id: m.id, description: m.description ?? '' })),
			quote_approval_policy: f.get('quote_approval_policy'),
		}
		if (reply) body.in_reply_to_id = reply.id
		if (quote) body.quoted_status_id = quote.id
		if (f.get('scheduled_at')) body.scheduled_at = new Date(f.get('scheduled_at')).toISOString()
		if (f.get('poll').trim())
			body.poll = {
				options: f
					.get('poll')
					.split('\n')
					.map((s) => s.trim())
					.filter(Boolean),
				...(pollDurationChanged ? { expires_in: Number(f.get('expires')) } : {}),
				multiple: f.has('multiple'),
				hide_totals: f.has('hide_totals'),
			}
		const fingerprint = JSON.stringify(body)
		if (submitted && submitted !== fingerprint) idempotencyKey = crypto.randomUUID()
		submitted = fingerprint
		const result = await api(edit ? '/api/v1/statuses/' + edit.id : '/api/v1/statuses', {
			method: edit ? 'PUT' : 'POST',
			body,
			headers: edit ? {} : { 'Idempotency-Key': idempotencyKey },
		})
		message(result.scheduled_at ? 'Post scheduled.' : 'Post saved.')
		composer(root, onPosted)
		await onPosted(result)
	})
	text.focus()
}
