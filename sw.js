// VEGA service worker: makes the deck installable, keeps it opening offline,
// and shows background alerts sent by the relay.
const SHELL = 'vega-shell-v1', CFG = 'vega-cfg';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png']).catch(() => {}))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Network first, so updates arrive immediately; the cached shell is the offline fallback.
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
});

// The page tells the worker where the relay is and which device this is.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'cfg') e.waitUntil(caches.open(CFG).then((c) => c.put('cfg', new Response(JSON.stringify(e.data.cfg)))));
});
async function cfg() {
  try { const r = await (await caches.open(CFG)).match('cfg'); return r ? await r.json() : null; } catch (x) { return null; }
}

// The relay sends an empty push; the details wait in the device's inbox.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find((w) => w.visibilityState === 'visible');
    if (visible) { visible.postMessage({ type: 'inbox' }); return; }
    let items = [];
    try {
      const c = await cfg();
      if (c && c.relay && c.device) {
        const r = await fetch(c.relay + '/inbox?device=' + encodeURIComponent(c.device));
        if (r.ok) items = (await r.json()).items || [];
      }
    } catch (x) { /* fall through to the generic notice */ }
    if (!items.length) items = [{ title: 'VEGA', body: 'Something needs your attention.', tag: 'vega' }];
    for (const it of items) {
      await self.registration.showNotification(it.title || 'VEGA', {
        body: it.body || '', tag: it.tag || 'vega-' + it.id, icon: './icon-192.png', badge: './icon-192.png', data: it.data || {},
      });
    }
    wins.forEach((w) => w.postMessage({ type: 'inbox-items', items }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) { const w = wins[0]; try { await w.focus(); } catch (x) { /* focus is best effort */ } w.postMessage({ type: 'open', data: d }); }
    else await self.clients.openWindow('./' + (d.run ? '#run-' + encodeURIComponent(d.run) : ''));
  })());
});
