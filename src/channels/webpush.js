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

// ---------- VAPID ----------
/**
 * Import the VAPID key pair once per invocation. VAPID_PUBLIC_KEY is the base64url 65-byte uncompressed
 * P-256 point, VAPID_PRIVATE_KEY the base64url 32-byte scalar d. Throws 'vapid_invalid' on bad secrets.
 */
export async function importVapid(env) {
  const pub = b64uDecode(env.VAPID_PUBLIC_KEY); const d = b64uDecode(env.VAPID_PRIVATE_KEY);
  if (!pub || pub.length !== 65 || pub[0] !== 4 || !d || d.length !== 32 || !env.VAPID_SUBJECT) throw new Error('vapid_invalid');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: b64uEncode(d) };
  let key;
  try { key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); } catch { throw new Error('vapid_invalid'); }
  return { key, publicKey: b64uEncode(pub), subject: String(env.VAPID_SUBJECT), cache: new Map(), signs: 0 };
}
export const JWT_TTL_S = 3600; // under every push service's 24 h maximum; tokens live for one invocation only

/** `Authorization` header for one push-service origin. One ES256 signature per origin per invocation. */
export async function vapidAuth(vapid, audience, now) {
  const hit = vapid.cache.get(audience); if (hit) return hit;
  const enc = new TextEncoder();
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + JWT_TTL_S, sub: vapid.subject })));
  // WebCrypto ECDSA returns raw r||s (64 bytes): exactly the JWS ES256 signature, no DER step.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, enc.encode(head + '.' + body));
  vapid.signs++;
  const h = `vapid t=${head}.${body}.${b64uEncode(new Uint8Array(sig))}, k=${vapid.publicKey}`;
  vapid.cache.set(audience, h);
  return h;
}

/**
 * Send one payload-less push. ctx = {fetchFn, vapid, now, skipOrigins: Set}. Never throws.
 * Returns {ok, gone?, retry?, error?, origin}: 2xx ok; 404/410 gone (delete the target); 429 retry and
 * skip that origin for the rest of the run; 5xx/network retry; other 4xx (bad JWT, key mismatch) failure.
 * The digest is ignored: the service worker fetches the text from /api/alerts/inbox.
 */
export async function send(target, digest, ctx) {
  if (!allowedEndpoint(target.address)) return { ok: false, gone: true, error: 'bad_endpoint', origin: null };
  const origin = new URL(target.address).origin;
  if (ctx.skipOrigins?.has(origin)) return { ok: false, retry: true, error: 'http_429', origin };
  let res;
  try {
    // No body: for a bodiless POST fetch itself sends Content-Length: 0 (Fetch standard), so we don't set it.
    res = await ctx.fetchFn(target.address, { method: 'POST', headers: { Authorization: await vapidAuth(ctx.vapid, origin, ctx.now), TTL: '21600', Urgency: 'normal', Topic: 'flat-hunt-alerts' } });
  } catch { return { ok: false, retry: true, error: 'network', origin }; }
  const s = res.status;
  try { await res.body?.cancel(); } catch { /* nothing to read */ }
  if (s >= 200 && s < 300) return { ok: true, origin };
  if (s === 404 || s === 410) return { ok: false, gone: true, error: 'http_' + s, origin };
  if (s === 429) { ctx.skipOrigins?.add(origin); return { ok: false, retry: true, error: 'http_429', origin }; }
  if (s >= 500) return { ok: false, retry: true, error: 'http_' + s, origin };
  return { ok: false, error: 'http_' + s, origin };
}

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
