/* Injury Wire service worker — Web Push receiver (v78) */
self.addEventListener('push', (event) => {
  let data = { title: 'Injury Wire', body: 'New injury update', url: './' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) { /* fall back to defaults */ }
  const opts = {
    body: data.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || './' },
    tag: 'injury-wire-alert',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(data.title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes('injury-wire')) { w.focus(); return; }
      }
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
