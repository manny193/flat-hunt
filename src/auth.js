// Pluggable auth: Cloudflare Access identity, else built-in password login with a signed session cookie.
// All crypto is Web Crypto HMAC-SHA256 (cheap enough for the 10 ms CPU budget; no PBKDF2).

import { parseCookies, clientIp } from './http.js';

export const COOKIE = '__Host-fr_session';
export const SESSION_DAYS = 30;
export const LOGIN_WINDOW_MS = 15 * 60e3;
export const LOGIN_MAX_FAILS = 5;

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const keyCache = new Map();
async function hmacKey(secret) {
  let k = keyCache.get(secret);
  if (!k) { k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); if (keyCache.size > 8) keyCache.clear(); keyCache.set(secret, k); }
  return k;
}
export async function hmac(secret, msg) { return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(msg))); }
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
/** Constant-time password check: HMAC both sides with the session secret, compare the digests. */
export async function passwordMatches(env, given) {
  if (typeof given !== 'string' || !given || given.length > 1024) return false;
  const [a, b] = await Promise.all([hmac(env.SESSION_SECRET, 'pw:' + given), hmac(env.SESSION_SECRET, 'pw:' + env.APP_PASSWORD)]);
  return timingSafeEqual(a, b);
}

/** Session token: base64url("v1.<expiresAtSeconds>.<nonce>") + "." + base64url(HMAC). */
export async function createSession(env, now = Date.now()) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `v1.${Math.floor(now / 1000) + SESSION_DAYS * 86400}.${nonce}`;
  return b64url(enc.encode(payload)) + '.' + b64url(await hmac(env.SESSION_SECRET, payload));
}
export async function verifySession(env, token, now = Date.now()) {
  if (!token || typeof token !== 'string' || token.length > 300) return false;
  const [p, s] = token.split('.');
  if (!p || !s) return false;
  let payload, sig;
  try { payload = new TextDecoder().decode(fromB64url(p)); sig = fromB64url(s); } catch { return false; }
  const m = /^v1\.(\d{1,12})\.[A-Za-z0-9_-]{8,40}$/.exec(payload);
  if (!m) return false;
  if (!timingSafeEqual(sig, await hmac(env.SESSION_SECRET, payload))) return false;
  return Number(m[1]) * 1000 > now;
}
export const sessionCookie = token => `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// ---------- Cloudflare Access ----------
// The email header alone can be forged if the Worker is also reachable outside Access (workers.dev).
// When CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set, the signed JWT is verified too.
const jwksCache = { url: '', at: 0, keys: [] };
async function accessKeys(env, fetchFn) {
  const url = `https://${String(env.CF_ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '')}/cdn-cgi/access/certs`;
  if (jwksCache.url === url && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const r = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('Access certs fetch failed: ' + r.status);
  const { keys = [] } = await r.json();
  jwksCache.url = url; jwksCache.at = Date.now(); jwksCache.keys = keys;
  return keys;
}
export function resetAccessCache() { jwksCache.url = ''; jwksCache.at = 0; jwksCache.keys = []; }
export async function verifyAccessJwt(env, jwt, fetchFn = fetch, now = Date.now()) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))); claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const jwk = (await accessKeys(env, fetchFn)).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.CF_ACCESS_AUD)) return null;
  if (!claims.exp || claims.exp * 1000 < now) return null;
  return claims.email || claims.sub || 'access-user';
}

// ---------- middleware ----------
/** How this deployment authenticates. 'unconfigured' fails closed (503). */
export function authMode(env) {
  if (env.AUTH_MODE === 'cloudflare-access') return 'cloudflare-access';
  if (env.APP_PASSWORD && env.SESSION_SECRET) return 'password';
  // Only the Node server sets RUNTIME=node; the Worker ignores AUTH_DISABLED.
  if (env.RUNTIME === 'node' && env.AUTH_DISABLED === '1') return 'disabled';
  return 'unconfigured';
}

/** Returns {user} when the request is authenticated, else {user:null, mode}. */
export async function authenticate(request, env, fetchFn = fetch) {
  const mode = authMode(env);
  if (mode === 'disabled') return { user: 'local-dev', mode };
  if (mode === 'cloudflare-access') {
    const email = request.headers.get('cf-access-authenticated-user-email');
    if (email) {
      if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return { user: email, mode };
      try { const who = await verifyAccessJwt(env, request.headers.get('cf-access-jwt-assertion'), fetchFn); if (who) return { user: who, mode }; } catch { /* fall through */ }
    }
    // Access mode can still fall back to the password login when it is configured.
    if (!(env.APP_PASSWORD && env.SESSION_SECRET)) return { user: null, mode };
  }
  if (env.APP_PASSWORD && env.SESSION_SECRET) {
    const token = parseCookies(request.headers.get('cookie'))[COOKIE];
    if (await verifySession(env, token)) return { user: 'owner', mode: 'password' };
    return { user: null, mode: 'password' };
  }
  return { user: null, mode: 'unconfigured' };
}

/** Login attempt with a DB-backed per-IP failure counter. Returns {ok, status, retryAfter?, cookie?}. */
export async function attemptLogin(request, env, repo, password, now = Date.now()) {
  if (!(env.APP_PASSWORD && env.SESSION_SECRET)) return { ok: false, status: 503 };
  const ip = clientIp(request);
  const fails = await repo.loginFailures(ip, now, LOGIN_WINDOW_MS);
  if (fails >= LOGIN_MAX_FAILS) return { ok: false, status: 429, retryAfter: Math.ceil(LOGIN_WINDOW_MS / 1000) };
  if (!(await passwordMatches(env, password))) { await repo.recordLoginFailure(ip, now, LOGIN_WINDOW_MS); return { ok: false, status: 401 }; }
  if (fails) await repo.clearLoginFailures(ip);
  return { ok: true, status: 204, cookie: sessionCookie(await createSession(env, now)) };
}
