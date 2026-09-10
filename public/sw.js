self.addEventListener('push', (event) => {
	let data
	try {
		data = event.data.json()
	} catch {
		return
	}
	event.waitUntil(
		self.registration.showNotification(data.title || 'Hyena', {
			body: data.body || 'New activity',
			icon: data.icon || '/avatar.svg',
			tag: String(data.notification_id || ''),
			data: { url: 'https://' + self.location.host + '/notifications' },
		})
	)
})
self.addEventListener('notificationclick', (event) => {
	event.notification.close()
	event.waitUntil(clients.openWindow('/notifications'))
})
