// Flat Hunt service worker: area alerts only (docs/ai/ALERTS-WEBPUSH.md §9).
// Pushes carry no payload. On a push we ask our own server for the text (same origin, session cookie), so
// listing details never pass through the push service and a signed-out device only sees a generic line.
// No 'fetch' handler on purpose: the app and its data are never cached (shared devices, auth).

const TAG = 'flat-hunt-alerts';
const GENERIC = { title: 'Flat Hunt', body: 'New flats in your areas. Open Flat Hunt to see them.', url: '/#alerts', tag: TAG };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Only our own hash routes may be opened from a notification.
const safeUrl = u => (typeof u === 'string' && /^\/#[\w-]{1,80}$/.test(u) ? u : '/#alerts');
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

self.addEventListener('push', e => e.waitUntil((async () => {
  let n = GENERIC;
  try {
    const r = await fetch('/api/alerts/inbox', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (r.ok) { const d = await r.json(); if (d && d.notification && d.notification.title) n = d.notification; }
  } catch { /* offline or signed out: generic text */ }
  // Browsers require every push to show a notification (userVisibleOnly), so this always shows one.
  return self.registration.showNotification(text(n.title, 120) || GENERIC.title, {
    body: text(n.body, 400), tag: text(n.tag, 60) || TAG, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: safeUrl(n.url) },
  });
})()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = safeUrl(e.notification.data && e.notification.data.url);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      try { await w.focus(); return await w.navigate(url); } catch { /* not controlled by us yet: open a new window */ }
    }
    return self.clients.openWindow(url);
  })());
});

// The browser rotated the subscription: subscribe again with our key and tell the server (cookie rides along).
// The old endpoint starts answering 404/410 and the server deletes it on the next send.
const coarseLabel = () => {
  const ua = (self.navigator && self.navigator.userAgent) || '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
};
const fromB64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
self.addEventListener('pushsubscriptionchange', e => e.waitUntil((async () => {
  try {
    let sub = e.newSubscription;
    if (!sub) {
      const cfg = await (await fetch('/api/alerts/config', { credentials: 'same-origin', cache: 'no-store' })).json();
      if (!cfg.enabled || !cfg.vapidPublicKey) return;
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(cfg.vapidPublicKey) });
    }
    await fetch('/api/alerts/targets', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'webpush', subscription: sub.toJSON(), label: coarseLabel() }) });
  } catch { /* the user can turn alerts on again from the app */ }
})()));
