// Web Push channel (VAPID, RFC 8292) with WebCrypto only: no npm, same code in Workers and Node 22.
// Pushes are payload-less (docs/ai/ALERTS-WEBPUSH.md §8): the service worker fetches the text itself.
// Endpoints are personal data and capabilities: never log them, never put them in an error message.
import { HttpError } from '../http.js';

export const name = 'webpush';

// ---------- base64url (atob/btoa exist in Workers and Node; Buffer does not exist in Workers) ----------
export function b64uEncode(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  if (typeof str !== 'string' || str.length > 2048 || !/^[A-Za-z0-9_-]*={0,2}$/.test(str)) return null;
  const s = str.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length % 4 === 1) return null;
  try { return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); } catch { return null; }
}

// ---------- target validation (SSRF guard: the cron POSTs to whatever endpoint we store) ----------
// Push services in use today. [unverified: confirm hosts from real subscriptions during QA; add new ones here.]
const PUSH_HOSTS = [
  h => h === 'fcm.googleapis.com',                 // Chrome, Edge on Android, Opera, Samsung Internet
  h => h === 'updates.push.services.mozilla.com',  // Firefox
  h => h.endsWith('.push.apple.com'),              // Safari macOS / iOS (web.push.apple.com)
  h => h.endsWith('.notify.windows.com'),          // Edge on Windows (WNS)
];
export const MAX_ENDPOINT = 1024;
export function allowedEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT) return false;
  let u; try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some(ok => ok(host));
}
/** Coarse device label from the client ('Android · Chrome'): letters, digits and a little punctuation. */
export const cleanLabel = v => String(typeof v === 'string' ? v : '').replace(/[^\p{L}\p{N} ·()./,+-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** Validate a PushSubscription JSON. Returns {address, keys, label} or throws a 400. */
export function validateTarget(input) {
  const sub = input?.subscription;
  const bad = (code, msg) => { throw new HttpError(400, code, msg); };
  if (!sub || typeof sub !== 'object') bad('bad_subscription', 'Send the browser push subscription.');
  if (!allowedEndpoint(sub.endpoint)) bad('bad_endpoint', 'That push service is not supported.');
  const p256dh = b64uDecode(sub.keys?.p256dh), auth = b64uDecode(sub.keys?.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) bad('bad_keys', 'The subscription keys are not valid.');
  if (!auth || auth.length !== 16) bad('bad_keys', 'The subscription keys are not valid.');
  return { address: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: cleanLabel(input.label) };
}
