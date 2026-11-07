// Auth: Google sign-in (src/google.js) for everyone, the APP_PASSWORD login as an admin-only
// "break-glass" fallback, and optionally Cloudflare Access. One signed session cookie for all of them.
// Roles: public (no session) < pending (signed in, awaiting approval) < user < admin. The role and
// approval state are re-read from D1 on every request (one indexed query), so revocation is immediate.
// All crypto is Web Crypto HMAC-SHA256 (cheap enough for the 10 ms CPU budget; no PBKDF2).

import { parseCookies, clientIp } from './http.js';

export const COOKIE = '__Host-flat-hunt-session';
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
export { b64url, fromB64url };
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

/**
 * Session token: base64url(payload) + "." + base64url(HMAC(payload)).
 *   v1.<expiresAtSeconds>.<nonce>               break-glass password session (always admin)
 *   v2.<expiresAtSeconds>.<userId>.<a|u>.<nonce> Google (or Access) user session; role hint only,
 *                                                the DB row decides on every request.
 */
const sign = async (env, payload) => b64url(enc.encode(payload)) + '.' + b64url(await hmac(env.SESSION_SECRET, payload));
const nonce12 = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
const expiry = now => Math.floor(now / 1000) + SESSION_DAYS * 86400;
export async function createSession(env, now = Date.now()) { return sign(env, `v1.${expiry(now)}.${nonce12()}`); }
export async function createUserSession(env, userId, role, now = Date.now()) {
  return sign(env, `v2.${expiry(now)}.${Number(userId)}.${role === 'admin' ? 'a' : 'u'}.${nonce12()}`);
}
/** Returns null, {kind:'password'} or {kind:'user', userId, role}. */
export async function readSession(env, token, now = Date.now()) {
  if (!env.SESSION_SECRET || !token || typeof token !== 'string' || token.length > 300) return null;
  const [p, s, extra] = token.split('.');
  if (!p || !s || extra !== undefined) return null;
  let payload, sig;
  try { payload = new TextDecoder().decode(fromB64url(p)); sig = fromB64url(s); } catch { return null; }
  const m = /^v1\.(\d{1,12})\.[A-Za-z0-9_-]{8,40}$/.exec(payload) || /^v2\.(\d{1,12})\.(\d{1,12})\.([au])\.[A-Za-z0-9_-]{8,40}$/.exec(payload);
  if (!m) return null;
  if (!timingSafeEqual(sig, await hmac(env.SESSION_SECRET, payload))) return null;
  if (Number(m[1]) * 1000 <= now) return null;
  return payload.startsWith('v1.') ? { kind: 'password' } : { kind: 'user', userId: Number(m[2]), role: m[3] === 'a' ? 'admin' : 'user' };
}
export async function verifySession(env, token, now = Date.now()) { return !!(await readSession(env, token, now)); }
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
export const googleConfigured = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);
export const passwordConfigured = env => !!(env.APP_PASSWORD && env.SESSION_SECRET);
export const loginMethods = env => ({ google: googleConfigured(env), password: passwordConfigured(env) });
/** ADMIN_EMAILS: comma/space separated, case-insensitive. */
export const adminEmails = env => String(env.ADMIN_EMAILS || '').split(/[,\s]+/).map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
/** The account the break-glass password signs in as: the first ADMIN_EMAILS entry, so state carries over to Google sign-in later. */
export const breakGlassEmail = env => adminEmails(env)[0] || 'break-glass@flat-hunt.invalid';

/** How this deployment authenticates. 'unconfigured' fails closed (503). */
export function authMode(env) {
  // The Access email header alone is forgeable whenever a request reaches the Worker without passing
  // Access (Access app removed or misconfigured, another hostname). Trust Access only with JWT checks.
  if (env.AUTH_MODE === 'cloudflare-access' && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) return 'cloudflare-access';
  if (passwordConfigured(env)) return 'password';
  if (googleConfigured(env)) return 'google';
  // Only the Node server sets RUNTIME=node; the Worker ignores AUTH_DISABLED.
  if (env.RUNTIME === 'node' && env.AUTH_DISABLED === '1') return 'disabled';
  return 'unconfigured';
}

const ROLE_RANK = { public: 0, pending: 1, user: 2, admin: 3 };
export const atLeast = (who, role) => ROLE_RANK[who.role] >= ROLE_RANK[role];
const TOUCH_MS = 3600e3;

/** Effective role for a user row: blocked users are public, env admins are always admin. */
export function roleOf(user, env) {
  if (!user || user.status === 'blocked') return 'public';
  if (user.role === 'admin' || adminEmails(env).includes(String(user.email).toLowerCase())) return 'admin';
  return user.status === 'pending' ? 'pending' : 'user';
}

/** Find or create the account behind a break-glass password session. Always an active admin. */
export async function breakGlassUser(repo, env, now = Date.now()) {
  const email = breakGlassEmail(env);
  const u = await repo.getUserByEmail(email);
  if (u && u.role === 'admin' && u.status === 'active') return u;
  return repo.upsertUser({ email, name: u?.name || 'Admin (password)', role: 'admin', status: 'active' }, now);
}

/**
 * Who is calling. Returns {role, user, mode, via}. role is 'public' when nobody is signed in;
 * mode 'unconfigured' tells the caller to fail closed on private routes.
 */
export async function identify(request, env, repo, fetchFn = fetch, now = Date.now()) {
  const mode = authMode(env);
  const pub = { role: 'public', user: null, mode, via: null };
  if (mode === 'disabled') {
    // Local dev only: one admin account, created on first use (cached per repository instance).
    if (!repo.__devUser) { repo.__devUser = await repo.upsertUser({ email: 'dev@localhost', name: 'Local dev', role: 'admin', status: 'active' }, now); await repo.adoptLegacyState(repo.__devUser.id, now); }
    return { role: 'admin', user: repo.__devUser, mode, via: 'dev' };
  }
  if (mode === 'cloudflare-access' && request.headers.get('cf-access-authenticated-user-email')) {
    let email = null;
    try { email = await verifyAccessJwt(env, request.headers.get('cf-access-jwt-assertion'), fetchFn); } catch { /* fall through */ }
    if (email) {
      email = String(email).toLowerCase().slice(0, 254);
      // Before accounts existed, Access meant "the owner": without ADMIN_EMAILS every Access user is admin.
      const admin = !adminEmails(env).length || adminEmails(env).includes(email);
      let user = await repo.getUserByEmail(email);
      if (!user || (admin && user.role !== 'admin')) { user = await repo.upsertUser({ email, role: admin ? 'admin' : 'user', status: 'active' }, now); if (admin) await repo.adoptLegacyState(user.id, now); }
      return { role: roleOf(user, env), user, mode, via: 'access' };
    }
  }
  const token = parseCookies(request.headers.get('cookie'))[COOKIE];
  const s = token ? await readSession(env, token, now) : null;
  if (!s) return pub;
  if (s.kind === 'password') {
    if (!passwordConfigured(env)) return pub; // break-glass switched off: old password sessions stop working
    const user = await breakGlassUser(repo, env, now);
    return { role: 'admin', user, mode, via: 'password' };
  }
  const user = await repo.getUser(s.userId);
  if (!user) return pub;
  if (!user.lastSeenAt || now - user.lastSeenAt > TOUCH_MS) { try { await repo.touchUser(user.id, now); } catch { /* best effort */ } }
  return { role: roleOf(user, env), user, mode, via: 'google' };
}

/** Login attempt with a DB-backed per-IP failure counter. Returns {ok, status, retryAfter?, cookie?}. */
export async function attemptLogin(request, env, repo, password, now = Date.now()) {
  if (!(env.APP_PASSWORD && env.SESSION_SECRET)) return { ok: false, status: 503 };
  const ip = clientIp(request);
  // Count the attempt *before* checking the password (one atomic upsert), so parallel requests
  // can't all read "4 failures so far" and get unlimited guesses. A correct password clears it.
  const attempts = await repo.recordLoginFailure(ip, now, LOGIN_WINDOW_MS);
  if (attempts > LOGIN_MAX_FAILS) return { ok: false, status: 429, retryAfter: Math.ceil(LOGIN_WINDOW_MS / 1000) };
  if (!(await passwordMatches(env, password))) return { ok: false, status: 401 };
  await repo.clearLoginFailures(ip);
  return { ok: true, status: 204, cookie: sessionCookie(await createSession(env, now)) };
}
