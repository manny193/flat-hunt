// Google sign-in without libraries: OAuth 2.0 authorization-code flow with PKCE (S256), state and
// nonce, then the id_token is verified locally (RS256 via Web Crypto against Google's JWKS).
//   GET /auth/google            -> 302 to Google, short-lived signed cookie holds state/nonce/verifier
//   GET /auth/google/callback   -> code exchange at Google's token endpoint, id_token checks
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Redirect URI: PUBLIC_BASE_URL + /auth/google/callback
// (the request's own origin when PUBLIC_BASE_URL is unset, e.g. local dev).

import { hmac, timingSafeEqual, b64url, fromB64url } from './auth.js';
import { parseCookies } from './http.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const OAUTH_COOKIE = '__Host-flat-hunt-oauth';
const OAUTH_TTL_S = 600;
const CLOCK_SKEW_S = 120;
const enc = new TextEncoder();
const dec = new TextDecoder();
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const redirectUri = (env, request) => (env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, '') : new URL(request.url).origin) + '/auth/google/callback';

// ---------- signed, short-lived flow cookie ----------
async function sealFlow(env, data) {
  const p = b64url(enc.encode(JSON.stringify(data)));
  return p + '.' + b64url(await hmac(env.SESSION_SECRET, 'oauth:' + p));
}
async function openFlow(env, value, now) {
  if (typeof value !== 'string' || value.length > 1500) return null;
  const [p, s, extra] = value.split('.');
  if (!p || !s || extra !== undefined) return null;
  try {
    if (!timingSafeEqual(fromB64url(s), await hmac(env.SESSION_SECRET, 'oauth:' + p))) return null;
    const d = JSON.parse(dec.decode(fromB64url(p)));
    return d && typeof d === 'object' && d.e * 1000 > now ? d : null;
  } catch { return null; }
}
const flowCookie = v => `${OAUTH_COOKIE}=${v}; Path=/; Max-Age=${OAUTH_TTL_S}; HttpOnly; Secure; SameSite=Lax`;
export const clearFlowCookie = () => `${OAUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** 302 to Google's consent screen. `next` must already be a safe same-site path. */
export async function startGoogle(request, env, next = '/', now = Date.now()) {
  const state = rand(24), nonce = rand(24), verifier = rand(48); // verifier: 64 chars, RFC 7636 allows 43-128
  const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(env, request), response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  const cookie = flowCookie(await sealFlow(env, { s: state, n: nonce, v: verifier, x: next, e: Math.floor(now / 1000) + OAUTH_TTL_S }));
  return new Response(null, { status: 302, headers: { location: `${GOOGLE_AUTH_URL}?${q}`, 'set-cookie': cookie } });
}

/**
 * Handle Google's redirect back. Returns {ok:true, profile:{email,name,picture,sub}, next}
 * or {ok:false, error, next}. Never throws for bad input.
 */
export async function finishGoogle(request, env, fetchFn = fetch, now = Date.now()) {
  const url = new URL(request.url);
  const flow = await openFlow(env, parseCookies(request.headers.get('cookie'))[OAUTH_COOKIE], now);
  const next = flow && typeof flow.x === 'string' ? flow.x : '/';
  if (url.searchParams.get('error')) return { ok: false, error: url.searchParams.get('error') === 'access_denied' ? 'google_cancelled' : 'google_failed', next };
  if (!flow) return { ok: false, error: 'google_expired', next };
  const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  if (!timingSafeEqual(enc.encode(state), enc.encode(String(flow.s))) || !code || code.length > 2048) return { ok: false, error: 'google_state', next };
  let tokens;
  try {
    const r = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(env, request), grant_type: 'authorization_code', code_verifier: flow.v }),
    });
    if (!r.ok) { console.warn('google token exchange failed', r.status); return { ok: false, error: 'google_failed', next }; }
    tokens = await r.json();
  } catch (e) { console.warn('google token exchange error', e?.message || e); return { ok: false, error: 'google_failed', next }; }
  const v = await verifyGoogleIdToken(env, tokens?.id_token, { nonce: flow.n, fetchFn, now });
  if (!v.ok) { console.warn('google id_token rejected:', v.reason); return { ok: false, error: v.reason === 'email_unverified' ? 'google_unverified' : 'google_failed', next }; }
  const c = v.claims;
  return { ok: true, next, profile: { email: String(c.email).toLowerCase().slice(0, 254), name: typeof c.name === 'string' ? c.name : '', picture: typeof c.picture === 'string' && /^https:\/\//.test(c.picture) ? c.picture : '', sub: String(c.sub || '') } };
}

// ---------- JWKS (cached per isolate, honours Cache-Control max-age) ----------
const jwks = { at: 0, ttl: 0, keys: new Map(), imported: new Map(), lastForced: 0 };
export function resetGoogleKeys() { jwks.at = 0; jwks.ttl = 0; jwks.keys = new Map(); jwks.imported = new Map(); jwks.lastForced = 0; }
async function loadKeys(fetchFn, now) {
  const r = await fetchFn(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('Google JWKS fetch failed: ' + r.status);
  const { keys = [] } = await r.json();
  const m = /max-age=(\d+)/i.exec(r.headers.get('cache-control') || '');
  jwks.keys = new Map(keys.filter(k => k && k.kid && k.kty === 'RSA').map(k => [k.kid, k])); jwks.imported = new Map();
  jwks.at = now; jwks.ttl = Math.min(Math.max(m ? Number(m[1]) * 1000 : 3600e3, 300e3), 86400e3);
}
async function keyFor(kid, fetchFn, now) {
  if (!jwks.at || now - jwks.at > jwks.ttl) await loadKeys(fetchFn, now);
  // Google rotates keys: on an unknown kid refetch once, at most once a minute.
  if (!jwks.keys.has(kid) && now - jwks.lastForced > 60e3) { jwks.lastForced = now; await loadKeys(fetchFn, now); }
  const jwk = jwks.keys.get(kid); if (!jwk) return null;
  let k = jwks.imported.get(kid);
  if (!k) { k = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); jwks.imported.set(kid, k); }
  return k;
}

/** Verify a Google id_token. Returns {ok:true, claims} or {ok:false, reason}. */
export async function verifyGoogleIdToken(env, idToken, { nonce, fetchFn = fetch, now = Date.now() } = {}) {
  const parts = typeof idToken === 'string' && idToken.length < 8192 ? idToken.split('.') : [];
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  let header, claims;
  try { header = JSON.parse(dec.decode(fromB64url(parts[0]))); claims = JSON.parse(dec.decode(fromB64url(parts[1]))); } catch { return { ok: false, reason: 'malformed' }; }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'alg' };
  let key;
  try { key = await keyFor(header.kid, fetchFn, now); } catch (e) { return { ok: false, reason: 'jwks: ' + (e?.message || e) }; }
  if (!key) return { ok: false, reason: 'unknown_kid' };
  let sigOk = false;
  try { sigOk = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(parts[0] + '.' + parts[1])); } catch { sigOk = false; }
  if (!sigOk) return { ok: false, reason: 'signature' };
  if (!GOOGLE_ISSUERS.includes(claims.iss)) return { ok: false, reason: 'iss' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!env.GOOGLE_CLIENT_ID || !aud.includes(env.GOOGLE_CLIENT_ID)) return { ok: false, reason: 'aud' };
  if (aud.length > 1 && claims.azp !== env.GOOGLE_CLIENT_ID) return { ok: false, reason: 'azp' };
  const t = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < t) return { ok: false, reason: 'expired' };
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > t) return { ok: false, reason: 'iat' };
  if (!nonce || typeof claims.nonce !== 'string' || !timingSafeEqual(enc.encode(claims.nonce), enc.encode(String(nonce)))) return { ok: false, reason: 'nonce' };
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) return { ok: false, reason: 'email' };
  if (claims.email_verified !== true && claims.email_verified !== 'true') return { ok: false, reason: 'email_unverified' };
  return { ok: true, claims };
}
