// Area alerts in the browser (docs/ai/ALERTS-WEBPUSH.md §9-10). Imported by ui.js; ui.js passes its helpers in,
// so this module never imports ui.js back. No inline styles (CSP): classes live in app.css.

/** Register the alerts service worker (signed-in users only; it has no fetch handler and caches nothing). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
}
