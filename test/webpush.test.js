// VAPID (RFC 8292) channel: JWT shape and signature, request headers, response classification.
// The key pair is generated here with WebCrypto; no real key is ever used. Push services are mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importVapid, vapidAuth, send, b64uDecode, b64uEncode, allowedEndpoint, JWT_TTL_S } from '../src/channels/webpush.js';

const b64u = b => Buffer.from(b).toString('base64url');
async function testVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { env: { VAPID_PUBLIC_KEY: b64u(raw), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: 'mailto:alerts@flat-hunt.invalid' }, publicKey: kp.publicKey };
}
const NOW = Date.UTC(2026, 10, 8, 6);

test('base64url helpers round-trip and reject junk', () => {
  const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37) & 255);
  assert.deepEqual(b64uDecode(b64uEncode(bytes)), bytes);
  assert.equal(b64uEncode(bytes), b64u(bytes));
  for (const junk of [null, 42, 'a b', 'abc$', 'A'.repeat(3000), 'A']) assert.equal(b64uDecode(junk), null, String(junk).slice(0, 10));
});

test('VAPID JWT: 3 base64url parts, ES256, aud = endpoint origin, exp within 24 h, signature verifies; one sign per origin', async () => {
  const { env, publicKey } = await testVapid();
  const vapid = await importVapid(env);
  const h1 = await vapidAuth(vapid, 'https://fcm.googleapis.com', NOW);
  const m = h1.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, h1.slice(0, 40));
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com'); assert.equal(claims.sub, env.VAPID_SUBJECT);
  assert.ok(claims.exp > NOW / 1000 && claims.exp <= NOW / 1000 + 24 * 3600); assert.equal(claims.exp, Math.floor(NOW / 1000) + JWT_TTL_S);
  assert.equal(m[4], env.VAPID_PUBLIC_KEY);
  const sig = Buffer.from(m[3], 'base64url'); assert.equal(sig.length, 64, 'raw r||s');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(m[1] + '.' + m[2])));
  assert.equal(await vapidAuth(vapid, 'https://fcm.googleapis.com', NOW + 1000), h1, 'cached for the invocation');
  await vapidAuth(vapid, 'https://web.push.apple.com', NOW);
  assert.equal(vapid.signs, 2);
});

test('importVapid refuses malformed secrets', async () => {
  const { env } = await testVapid();
  for (const bad of [{ VAPID_PUBLIC_KEY: 'abc' }, { VAPID_PRIVATE_KEY: 'abc' }, { VAPID_PUBLIC_KEY: b64u(new Uint8Array(65)) }]) await assert.rejects(importVapid({ ...env, ...bad }), /vapid_invalid/);
  for (const sub of ['', 'alerts@flat-hunt.invalid', 'http://flat-hunt.example', 'mailto:', 'ftp://x']) await assert.rejects(importVapid({ ...env, VAPID_SUBJECT: sub }), /vapid_subject/, sub);
  for (const sub of ['mailto:alerts@flat-hunt.invalid', 'https://flat-hunt.example.workers.dev']) await importVapid({ ...env, VAPID_SUBJECT: sub });
});

test('send: one bodiless POST with VAPID, TTL, Urgency and Topic headers; responses classified', async () => {
  const { env } = await testVapid();
  const vapid = await importVapid(env);
  const calls = []; let status = 201;
  const fetchFn = async (url, init) => { calls.push({ url, init }); return new Response(status === 204 ? null : 'x', { status }); };
  const ctx = { fetchFn, vapid, now: NOW, skipOrigins: new Set() };
  const t = { id: 1, address: 'https://fcm.googleapis.com/fcm/send/abc' };
  assert.deepEqual(await send(t, null, ctx), { ok: true, origin: 'https://fcm.googleapis.com' });
  const { url, init } = calls[0];
  assert.equal(url, t.address); assert.equal(init.method, 'POST'); assert.equal(init.body, undefined, 'payload-less');
  assert.match(init.headers.Authorization, /^vapid t=.+, k=/); assert.equal(init.headers.TTL, '21600'); assert.equal(init.headers.Urgency, 'normal'); assert.equal(init.headers.Topic, 'flat-hunt-alerts');
  const expect = { 404: { gone: true }, 410: { gone: true }, 403: {}, 400: {}, 500: { retry: true }, 503: { retry: true } };
  for (const [code, flags] of Object.entries(expect)) {
    status = Number(code);
    const r = await send(t, null, ctx);
    assert.equal(r.ok, false); assert.equal(r.error, 'http_' + code); assert.equal(!!r.gone, !!flags.gone, code); assert.equal(!!r.retry, !!flags.retry, code);
  }
  status = 429; const n = calls.length;
  assert.equal((await send(t, null, ctx)).retry, true);
  assert.equal((await send({ id: 2, address: 'https://fcm.googleapis.com/fcm/send/def' }, null, ctx)).error, 'http_429');
  assert.equal(calls.length, n + 1, 'origin skipped for the rest of the run after a 429');
  assert.equal((await send({ id: 3, address: 'https://evil.example.com/x' }, null, ctx)).gone, true, 'a stored endpoint off the allowlist is never fetched');
  assert.equal(calls.length, n + 1);
  const boom = await send(t, null, { ...ctx, skipOrigins: new Set(), fetchFn: async () => { throw new Error('offline'); } });
  assert.deepEqual([boom.retry, boom.error], [true, 'network']);
  assert.equal(vapid.signs, 1, 'one signature for one origin');
});

test('endpoint allowlist', () => {
  assert.equal(allowedEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(allowedEndpoint('https://web.push.apple.com/x'), true);
  assert.equal(allowedEndpoint('https://apple.com/x'), false);
  assert.equal(allowedEndpoint('https://xpush.apple.com/x'), false);
});
