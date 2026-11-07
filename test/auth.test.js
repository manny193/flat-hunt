// Auth middleware: fail-closed modes, password login, session cookie, rate limit, Origin check, Cloudflare Access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createSession, verifySession, COOKIE, verifyAccessJwt, resetAccessCache, LOGIN_MAX_FAILS } from '../src/auth.js';
import { memoryDb } from './helpers.js';

const BASE = 'https://radar.test';
const PW = 'correct horse battery staple';
const SECRET = 'test-session-secret-0123456789abcdef0123';
const assets = async req => ['/', '/app.css', '/manifest.webmanifest'].includes(new URL(req.url).pathname) ? new Response('asset', { headers: { 'content-type': 'text/plain' } }) : null;

async function harness(env, fetchFn) {
  const t = await memoryDb();
  const app = createApp({ repo: () => t.repo, assets, fetch: fetchFn });
  const call = (method, path, { body, headers = {} } = {}) => app.fetch(new Request(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env, {});
  return { ...t, call };
}
const pwEnv = { RUNTIME: 'worker', APP_PASSWORD: PW, SESSION_SECRET: SECRET };
const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];

test('fails closed with 503 when login is not configured; the Worker ignores AUTH_DISABLED', async () => {
  for (const env of [{ RUNTIME: 'worker' }, { RUNTIME: 'worker', AUTH_DISABLED: '1' }, { RUNTIME: 'node', APP_PASSWORD: PW }]) {
    const { call } = await harness(env);
    assert.equal((await call('GET', '/api/listings')).status, 503, JSON.stringify(env));
    assert.equal((await call('GET', '/', { headers: { accept: 'text/html' } })).status, 503);
    assert.equal((await call('GET', '/healthz')).status, 200, 'health stays public');
  }
  const { call } = await harness({ RUNTIME: 'node', AUTH_DISABLED: '1' });
  assert.equal((await call('GET', '/api/listings')).status, 200, 'Node honours AUTH_DISABLED for local dev');
});

test('password mode: API 401, pages redirect to /login, public files stay reachable', async () => {
  const { call } = await harness(pwEnv);
  const r = await call('GET', '/api/listings');
  assert.equal(r.status, 401); assert.equal((await r.json()).error, 'unauthenticated');
  const page = await call('GET', '/shortlist?x=1', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302); assert.equal(page.headers.get('location'), '/login?next=%2Fshortlist%3Fx%3D1');
  const login = await call('GET', '/login');
  assert.equal(login.status, 200); const html = await login.text();
  assert.match(html, /<form method="post" action="\/api\/login"/); assert.doesNotMatch(html, /<script|<style|style=/, 'no inline script or style (CSP)');
  assert.equal((await call('GET', '/app.css')).status, 200);
  assert.equal((await call('GET', '/manifest.webmanifest')).status, 200);
  assert.equal((await call('GET', '/app.js')).status, 401);
});

test('login: wrong password 401, right password sets a __Host- session cookie that unlocks the API', async () => {
  const { call } = await harness(pwEnv);
  assert.equal((await call('POST', '/api/login', { body: { password: 'nope' } })).status, 401);
  const ok = await call('POST', '/api/login', { body: { password: PW } });
  assert.equal(ok.status, 204);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, new RegExp(`^${COOKIE}=[^;]+; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$`));
  assert.equal((await call('GET', '/api/listings', { headers: { cookie: cookieOf(ok) } })).status, 200);
  assert.equal((await call('GET', '/login', { headers: { cookie: cookieOf(ok) } })).status, 302, 'logged-in users skip the login page');
  const out = await call('POST', '/api/logout');
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('form login (no JavaScript): 303 to a safe next path, errors go back to /login', async () => {
  const { call } = await harness(pwEnv);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const ok = await call('POST', '/api/login', { body: `password=${encodeURIComponent(PW)}&next=%2Fshortlist`, headers: form });
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/shortlist'); assert.ok(cookieOf(ok));
  const evil = await call('POST', '/api/login', { body: `password=${encodeURIComponent(PW)}&next=%2F%2Fevil.example`, headers: form });
  assert.equal(evil.headers.get('location'), '/', 'open redirect refused');
  const bad = await call('POST', '/api/login', { body: 'password=wrong', headers: form });
  assert.equal(bad.status, 303); assert.equal(bad.headers.get('location'), '/login?error=wrong');
});

test(`rate limit: after ${LOGIN_MAX_FAILS} wrong passwords the IP is locked out, even with the right one`, async () => {
  const { call } = await harness(pwEnv);
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) assert.equal((await call('POST', '/api/login', { body: { password: 'x' + i }, headers: ip })).status, 401);
  const locked = await call('POST', '/api/login', { body: { password: PW }, headers: ip });
  assert.equal(locked.status, 429); assert.equal(locked.headers.get('retry-after'), '900');
  assert.equal((await call('POST', '/api/login', { body: { password: PW }, headers: { 'cf-connecting-ip': '198.51.100.1' } })).status, 204, 'other IPs unaffected');
});

test('session cookie verification: tampered, expired, other secret, garbage', async () => {
  const env = { SESSION_SECRET: SECRET };
  const tok = await createSession(env);
  assert.equal(await verifySession(env, tok), true);
  const [p, s] = tok.split('.');
  const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  assert.equal(await verifySession(env, `${p}.${flipped}`), false, 'bad signature');
  const forged = btoa('v1.99999999999.AAAAAAAAAAAA').replace(/=+$/, '');
  assert.equal(await verifySession(env, `${forged}.${s}`), false, 'payload swapped');
  assert.equal(await verifySession(env, tok, Date.now() + 31 * 86400e3), false, 'expired after 30 days');
  assert.equal(await verifySession({ SESSION_SECRET: 'another-secret-another-secret-123' }, tok), false, 'rotated secret logs out');
  for (const g of ['', 'abc', 'a.b.c', '....', 'x'.repeat(400)]) assert.equal(await verifySession(env, g), false, g);
});

test('Origin check on state-changing API calls', async () => {
  const { call } = await harness({ RUNTIME: 'node', AUTH_DISABLED: '1' });
  const bad = await call('POST', '/api/areas', { body: { name: 'Green Glen' }, headers: { origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
  assert.equal((await call('POST', '/api/areas', { body: { name: 'Green Glen' }, headers: { origin: BASE } })).status, 201);
  assert.equal((await call('POST', '/api/login', { body: { password: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
});

// ---------- Cloudflare Access ----------
const b64u = b => Buffer.from(b).toString('base64url');
async function accessFixture() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256' };
  const sign = async claims => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })), p = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p));
    return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
  };
  const fetchFn = async url => { assert.equal(url, 'https://team.cloudflareaccess.com/cdn-cgi/access/certs'); return new Response(JSON.stringify({ keys: [jwk] })); };
  return { sign, fetchFn };
}

test('Cloudflare Access: email header trusted only in access mode; JWT verified when team/aud are set', async () => {
  resetAccessCache();
  const hdr = { 'cf-access-authenticated-user-email': 'me@example.com' };
  assert.equal((await (await harness(pwEnv)).call('GET', '/api/listings', { headers: hdr })).status, 401, 'ignored outside access mode');
  assert.equal((await (await harness({ RUNTIME: 'worker', AUTH_MODE: 'cloudflare-access' })).call('GET', '/api/listings', { headers: hdr })).status, 200);
  assert.equal((await (await harness({ RUNTIME: 'worker', AUTH_MODE: 'cloudflare-access' })).call('GET', '/api/listings')).status, 401);

  const { sign, fetchFn } = await accessFixture();
  const env = { RUNTIME: 'worker', AUTH_MODE: 'cloudflare-access', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud-123' };
  const { call } = await harness(env, fetchFn);
  const good = await sign({ aud: ['aud-123'], email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 600 });
  assert.equal((await call('GET', '/api/listings', { headers: { ...hdr, 'cf-access-jwt-assertion': good } })).status, 200);
  assert.equal((await call('GET', '/api/listings', { headers: hdr })).status, 401, 'forged header without JWT');
  const wrongAud = await sign({ aud: ['other'], email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(await verifyAccessJwt(env, wrongAud, fetchFn), null);
  const expired = await sign({ aud: ['aud-123'], email: 'me@example.com', exp: Math.floor(Date.now() / 1000) - 5 });
  assert.equal(await verifyAccessJwt(env, expired, fetchFn), null);
  assert.equal(await verifyAccessJwt(env, good.slice(0, -4) + 'AAAA', fetchFn), null, 'bad signature');
});
