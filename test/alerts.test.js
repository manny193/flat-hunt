// Area alerts over Web Push (docs/ai/ALERTS-WEBPUSH.md): schema, repo, enqueue, API, send step, inbox.
// Every network call is mocked; VAPID keys are generated inside the tests, never real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, GREEN_GLEN } from './helpers.js';
import { openSqlite, migrateSqlite } from '../src/db/node-sqlite.js';
import { loadMigrations } from '../src/db/fs-migrations.js';
import { sqliteDriver } from '../src/db/drivers.js';
import { createRepo } from '../src/db/repo.js';
import { ingestItems } from '../src/ingest.js';
import { runBackfill, startBackfill } from '../src/backfill.js';
import { budgeted, ingestDataset } from '../src/apify.js';
import { createApp, HOURLY_CRONS } from '../src/app.js';
import { alertStep, ALERT_CRON, inQuiet, istHourOf, istDayStart, alertText, GENERIC_NOTE, TEST_NOTE } from '../src/alerts.js';
import { readFileSync } from 'node:fs';
import { staticAssets } from '../src/node-server.js';
import { SECURITY_HEADERS } from '../src/http.js';
import { createUserSession, COOKIE } from '../src/auth.js';

const DAY = 864e5;
const DEFAULTS = { quietStart: 22, quietEnd: 8, maxListings: 30, maxDigests: 6, minGapMin: 60 };
const FCM = n => `https://fcm.googleapis.com/fcm/send/device-${n}`;

test('migration 0004 applies; tables exist; the 0003 schema still works without it (rollback safety)', async () => {
  const { raw, repo } = await memoryDb();
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  for (const t of ['alert_targets', 'alert_prefs', 'alert_areas', 'alert_queue']) assert.ok(names.includes(t), t);
  // Old code on the new schema: the usual repo calls are untouched by the new tables.
  const a = await repo.createArea(GREEN_GLEN, Date.now());
  assert.equal((await repo.listAreas()).length, 1); assert.ok(a.id);
  // And the schema before 0004 still opens and serves the old queries.
  const old = await openSqlite(':memory:');
  migrateSqlite(old, loadMigrations().filter(m => !m.name.startsWith('0004')));
  const oldRepo = createRepo(sqliteDriver(old));
  assert.deepEqual(await oldRepo.listAreas(), []);
});

test('repo: prefs, alert areas only for followed areas, unfollow and area delete remove alert rows', async () => {
  const { repo } = await memoryDb();
  const now = Date.now();
  const u = await repo.upsertUser({ email: 'a@example.com' }, now);
  const gg = await repo.createArea(GREEN_GLEN, now);
  const hsr = await repo.createArea({ name: 'HSR Layout', keywords: ['hsr layout'] }, now);
  await repo.linkArea(u.id, gg.id, now);
  assert.equal(await repo.alertPrefs(u.id), null);
  const areas = await repo.replaceAlertAreas(u.id, [{ areaId: gg.id, maxRent: 30000, bhks: ['1', '2'] }, { areaId: hsr.id }], now, DEFAULTS);
  assert.deepEqual(areas, [{ areaId: gg.id, name: 'Green Glen', maxRent: 30000, bhks: ['1', '2'] }], 'unfollowed HSR is dropped');
  assert.deepEqual(await repo.alertPrefs(u.id), { enabled: true, quietStart: 22, quietEnd: 8, maxListings: 30, maxDigests: 6, minGapMin: 60, testAt: null }, 'prefs created with defaults');
  const p = await repo.putAlertPrefs(u.id, { ...(await repo.alertPrefs(u.id)), quietStart: 23, enabled: false }, now);
  assert.equal(p.quietStart, 23); assert.equal(p.enabled, false);
  await repo.unlinkArea(u.id, gg.id);
  assert.deepEqual(await repo.alertAreas(u.id), [], 'unfollowing removes the alert');
  await repo.linkArea(u.id, gg.id, now);
  await repo.replaceAlertAreas(u.id, [{ areaId: gg.id }], now, DEFAULTS);
  await repo.deleteArea(gg.id);
  assert.deepEqual(await repo.alertAreas(u.id), [], 'deleting the area removes the alert');
});

test('repo: targets upsert, move between accounts, cap of 5 replaces the oldest, own-only delete', async () => {
  const { repo } = await memoryDb();
  const a = await repo.upsertUser({ email: 'a@example.com' }, 1);
  const b = await repo.upsertUser({ email: 'b@example.com' }, 1);
  const ids = [];
  for (let i = 1; i <= 6; i++) ids.push(await repo.upsertAlertTarget({ userId: a.id, channel: 'webpush', address: FCM(i), keys: {}, label: 'Device ' + i }, 1000 + i));
  const mine = await repo.alertTargets(a.id);
  assert.equal(mine.length, 5); assert.ok(!mine.some(t => t.id === ids[0]), 'oldest replaced');
  assert.ok(mine.every(t => !('address' in t) && !('keys' in t)), 'no endpoint in the public shape');
  const moved = await repo.upsertAlertTarget({ userId: b.id, channel: 'webpush', address: FCM(6), keys: {}, label: 'Shared' }, 2000);
  assert.equal(moved, ids[5], 'same row, new owner');
  assert.equal((await repo.alertTargets(a.id)).length, 4); assert.equal((await repo.alertTargets(b.id))[0].label, 'Shared');
  assert.equal(await repo.deleteAlertTarget(a.id, moved), false, 'not yours');
  assert.equal(await repo.deleteAlertTarget(b.id, moved), true);
});

test('repo: purge drops alert queue rows after 7 days and dead targets after a week of failures', async () => {
  const { repo, db } = await memoryDb();
  const now = 100 * DAY;
  await db.run("INSERT INTO alert_queue (user_id, listing_id, area_id, status, created_at) VALUES (1, 'old', 1, 'sent', ?), (1, 'new', 1, 'sent', ?)", [now - 8 * DAY, now - DAY]);
  await db.run("INSERT INTO alert_targets (user_id, channel, address, failures, created_at, updated_at) VALUES (1, 'webpush', 'x1', 5, 0, ?), (1, 'webpush', 'x2', 5, 0, ?), (1, 'webpush', 'x3', 0, 0, 0)", [now - 8 * DAY, now - DAY]);
  await repo.purgeOld(now - 30 * DAY, now);
  assert.deepEqual((await db.all('SELECT listing_id FROM alert_queue')).map(r => r.listing_id), ['new']);
  assert.deepEqual((await db.all('SELECT address FROM alert_targets ORDER BY address')).map(r => r.address), ['x2', 'x3']);
});

// ---------- enqueue (ingest hook) ----------
const NOW = Date.UTC(2026, 10, 8, 6);
const HSR = { name: 'HSR Layout', keywords: ['hsr layout', 'hsr'], active: true };
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
let seq = 0;
const item = (text, msAgo = 36e5) => ({ text, group: 'Bellandur Flats', url: `https://www.facebook.com/groups/9/posts/${++seq}/`, createdAt: at(msAgo) });

async function alertWorld({ enabled = true } = {}) {
  const t = await memoryDb();
  const gg = await t.repo.createArea(GREEN_GLEN, NOW), hsr = await t.repo.createArea(HSR, NOW);
  const u = await t.repo.upsertUser({ email: 'u@example.com' }, NOW);
  await t.repo.linkArea(u.id, gg.id, NOW); await t.repo.linkArea(u.id, hsr.id, NOW);
  await t.repo.replaceAlertAreas(u.id, [{ areaId: gg.id }, { areaId: hsr.id }], NOW, DEFAULTS);
  await t.repo.putSettings({ alerts: { enabled } });
  const queue = async () => t.db.all('SELECT * FROM alert_queue ORDER BY created_at, listing_id');
  return { ...t, gg, hsr, u, queue };
}

test('enqueue: new listing in an alerted area queues one row; two alerted areas still one row; repost none', async () => {
  const w = await alertWorld();
  const one = item('2BHK semi-furnished flat in Green Glen Layout and close to HSR Layout. Rent 32,000. Call 9000011111');
  await ingestItems(w.repo, [one], { source: 'apify', now: NOW, storeAll: true });
  let q = await w.queue();
  assert.equal(q.length, 1); assert.equal(q[0].status, 'pending'); assert.equal(q[0].user_id, w.u.id);
  assert.equal(q[0].area_id, Math.min(w.gg.id, w.hsr.id));
  // Same flat reposted in another group a bit later: merged into the stored listing, no new alert.
  await ingestItems(w.repo, [{ ...one, group: 'Flats without Brokers', url: `https://www.facebook.com/groups/10/posts/${++seq}/`, createdAt: at(10 * 60e3) }], { source: 'apify', now: NOW + 60e3, storeAll: true });
  q = await w.queue(); assert.equal(q.length, 1, 'repost merged, not queued');
  assert.equal((await w.repo.listListings()).length, 1);
});

test('enqueue: samples, imports, seeking, old posts and posts without an area never queue', async () => {
  const w = await alertWorld();
  await ingestItems(w.repo, [item('2BHK in Green Glen Layout, rent 25000, call 9000022222')], { source: 'sample', sample: true, now: NOW });
  await ingestItems(w.repo, [item('3BHK in Green Glen Layout, rent 41000, call 9000022223')], { source: 'manual', now: NOW, storeAll: true });
  await ingestItems(w.repo, [item('Looking for a 1BHK in Green Glen Layout, budget 20k, from January.')], { source: 'apify', now: NOW, storeAll: true });
  await ingestItems(w.repo, [item('1BHK in Green Glen Layout, rent 18000, call 9000022224', 2 * DAY)], { source: 'apify', now: NOW, storeAll: true });
  await ingestItems(w.repo, [item('2BHK in Koramangala 5th block, rent 38000, call 9000022225')], { source: 'reddit', now: NOW, storeAll: true });
  assert.equal((await w.repo.listListings()).length, 5, 'all stored');
  assert.deepEqual(await w.queue(), []);
});

test('enqueue: max rent and BHK filters; unknown rent or BHK is included; alerts off or paused queues nothing', async () => {
  const w = await alertWorld();
  await w.repo.replaceAlertAreas(w.u.id, [{ areaId: w.gg.id, maxRent: 30000, bhks: ['2'] }], NOW, DEFAULTS);
  const posts = [
    item('2BHK flat in Green Glen Layout, rent 28,000, call 9000033331'),
    item('2BHK flat in Green Glen Layout with a big balcony, rent 45,000, call 9000033332'),
    item('3BHK flat in Green Glen Layout near the lake, rent 29,000, call 9000033333'),
    item('2BHK flat available in Green Glen Layout, owner direct, call 9000033334'),
    item('Flat available in Green Glen Layout for family, rent 22000, call 9000033335'),
  ];
  const res = await ingestItems(w.repo, posts, { source: 'phone', now: NOW, storeAll: true });
  assert.equal(res.report.newListings, 5);
  const rows = await w.queue(); const L = await w.repo.loadListings(rows.map(r => r.listing_id));
  const queued = [...L.values()].map(l => `${l.rent ?? '-'}/${l.bhk ?? '-'}`).sort();
  assert.deepEqual(queued, ['-/2', '22000/-', '28000/2']);

  const off = await alertWorld({ enabled: false });
  await ingestItems(off.repo, [item('2BHK flat in Green Glen Layout, rent 27,000, call 9000033336')], { source: 'apify', now: NOW, storeAll: true });
  assert.deepEqual(await off.queue(), [], 'kill switch off: no statement, no rows');
  const paused = await alertWorld();
  await paused.repo.putAlertPrefs(paused.u.id, { ...(await paused.repo.alertPrefs(paused.u.id)), enabled: false }, NOW);
  await ingestItems(paused.repo, [item('2BHK flat in Green Glen Layout, rent 26,000, call 9000033337')], { source: 'apify', now: NOW, storeAll: true });
  assert.deepEqual(await paused.queue(), [], 'user paused all alerts');
});

test('enqueue: an area backfill tags old posts but never alerts', async () => {
  const w = await alertWorld();
  await ingestItems(w.repo, [item('2BHK in Bellandur near Ecospace, rent 30000, call 9000044441')], { source: 'apify', now: NOW, storeAll: true });
  const bel = await w.repo.createArea({ name: 'Bellandur', keywords: ['bellandur'] }, NOW);
  await w.repo.linkArea(w.u.id, bel.id, NOW);
  await w.repo.replaceAlertAreas(w.u.id, [{ areaId: bel.id }], NOW, DEFAULTS);
  await startBackfill(w.repo, bel, NOW); await runBackfill(w.repo, { now: NOW });
  assert.equal((await w.repo.listListings({ area: bel.id })).length, 1, 'backfill matched it');
  assert.deepEqual(await w.queue(), []);
});

test('enqueue costs exactly one extra D1 statement per ingest call', async () => {
  const count = async enabled => {
    const w = await alertWorld({ enabled });
    const r = budgeted(w.repo);
    await ingestItems(r, [item('2BHK flat in Green Glen Layout, rent 27,500, call 9000055551'), item('1BHK in HSR Layout sector 2, rent 19,000, call 9000055552')], { source: 'apify', now: NOW, storeAll: true });
    return { used: r.used(), queued: (await w.queue()).length };
  };
  const off = await count(false), on = await count(true);
  assert.equal(on.used - off.used, 1); assert.equal(on.queued, 2); assert.ok(on.used <= 48);
});

test('a full webhook dataset ingest (all pages) with alerts on stays within the 48-statement budget', async () => {
  const w = await alertWorld();
  const rows = Array.from({ length: 200 }, (_, i) => ({ type: 'post', text: `${1 + (i % 3)}BHK in Green Glen Layout, rent ${20000 + i * 100}. ${['tower', 'villa', 'lake', 'metro'].map(x => x + 'q' + i).join(' ')} call 90000${10000 + i}`, url: `https://www.facebook.com/groups/111/posts/${i}/`, createdAt: new Date(Date.now() - i * 60e3).toISOString() }));
  const fetchFn = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/items')) { const off = +u.searchParams.get('offset'), lim = +u.searchParams.get('limit'); return Response.json(rows.slice(off, off + lim)); }
    return Response.json({ data: {} });
  };
  const r = budgeted(w.repo);
  const res = await ingestDataset(r, { APIFY_TOKEN: 't' }, { datasetId: 'dsALERT0001' }, { fetchFn });
  assert.equal(res.status, 'partial');
  assert.ok(r.used() <= 48, `used ${r.used()}`);
  assert.ok((await w.queue()).length > 0, 'alerts were queued');
});

// ---------- user API ----------
const BASE = 'https://hunt.test';
const b64u = b => Buffer.from(b).toString('base64url');
/** A throwaway VAPID key pair made with WebCrypto for this test run. Never a real key. */
async function testVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { VAPID_PUBLIC_KEY: b64u(raw), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: 'mailto:alerts@flat-hunt.invalid', publicKey: kp.publicKey };
}
const subKeys = () => ({ p256dh: b64u(Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)])), auth: b64u(new Uint8Array(16).fill(7)) });
const sub = (endpoint, keys = subKeys()) => ({ channel: 'webpush', subscription: { endpoint, keys }, label: 'Android · Chrome' });

async function apiHarness({ alerts = { enabled: true, adminOnly: false }, vapid = true, fetchFn } = {}) {
  const t = await memoryDb();
  const keys = vapid ? await testVapid() : {};
  const env = { RUNTIME: 'worker', SESSION_SECRET: 'session-secret-0123456789abcdef0123', ADMIN_EMAILS: 'boss@example.com', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'gsecret', PUBLIC_BASE_URL: BASE, ...keys };
  delete env.publicKey;
  const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: fetchFn });
  if (alerts) await t.repo.putSettings({ alerts });
  const sessionFor = async (email, role = 'user', status = 'active') => {
    const u = await t.repo.upsertUser({ email, name: email.split('@')[0], role, status }, Date.now());
    return { user: u, cookie: `${COOKIE}=${await createUserSession(env, u.id, role)}` };
  };
  const call = async (method, path, body, cookie) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'sec-fetch-site': 'same-origin' } : {}) };
    const r = await app.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, text, headers: r.headers };
  };
  return { ...t, app, env, keys, call, sessionFor };
}

test('alerts API: public 401 and pending 403 on every route', async () => {
  const h = await apiHarness();
  const pending = await h.sessionFor('p@example.com', 'user', 'pending');
  const routes = [['GET', '/api/alerts/config'], ['PUT', '/api/alerts/prefs', {}], ['PUT', '/api/alerts/areas', { areas: [] }], ['POST', '/api/alerts/targets', sub(FCM(1))], ['DELETE', '/api/alerts/targets/1'], ['GET', '/api/alerts/inbox'], ['POST', '/api/alerts/test']];
  for (const [m, p, b] of routes) {
    assert.equal((await h.call(m, p, b)).status, 401, `public ${m} ${p}`);
    assert.equal((await h.call(m, p, b, pending.cookie)).status, 403, `pending ${m} ${p}`);
  }
});

test('alerts API: soft launch and kill switch (off by default, admins only, VAPID missing); DELETE always works', async () => {
  const h = await apiHarness({ alerts: null });
  const u = await h.sessionFor('u@example.com'), boss = await h.sessionFor('boss@example.com');
  let c = await h.call('GET', '/api/alerts/config', undefined, u.cookie);
  assert.equal(c.status, 200); assert.equal(c.data.enabled, false); assert.equal(c.data.reason, 'off'); assert.equal(c.data.vapidPublicKey, null);
  assert.equal((await h.call('PUT', '/api/alerts/prefs', { enabled: true }, u.cookie)).data.error, 'alerts_off');
  await h.repo.putSettings({ alerts: { enabled: true } }); // adminOnly defaults to true
  c = await h.call('GET', '/api/alerts/config', undefined, u.cookie); assert.equal(c.data.reason, 'admin_only');
  const r = await h.call('PUT', '/api/alerts/prefs', { quietStart: 23 }, u.cookie); assert.equal(r.status, 403); assert.equal(r.data.reason, 'admin_only');
  const a = await h.call('GET', '/api/alerts/config', undefined, boss.cookie);
  assert.equal(a.data.enabled, true); assert.equal(a.data.vapidPublicKey, h.env.VAPID_PUBLIC_KEY);
  assert.equal((await h.call('PUT', '/api/alerts/prefs', { quietStart: 23 }, boss.cookie)).data.prefs.quietStart, 23);
  const tid = (await h.call('POST', '/api/alerts/targets', sub(FCM(1)), boss.cookie)).data.id;
  await h.repo.putSettings({ alerts: { enabled: false } });
  assert.equal((await h.call('POST', '/api/alerts/targets', sub(FCM(2)), boss.cookie)).status, 403);
  assert.equal((await h.call('DELETE', `/api/alerts/targets/${tid}`, undefined, boss.cookie)).status, 204, 'removing a device works with alerts off');
  const nov = await apiHarness({ vapid: false });
  const x = await nov.sessionFor('boss@example.com');
  assert.equal((await nov.call('GET', '/api/alerts/config', undefined, x.cookie)).data.reason, 'not_configured');
});

test('alerts API: prefs validation, areas must be followed, at most 10, filters validated', async () => {
  const h = await apiHarness();
  const u = await h.sessionFor('u@example.com');
  for (const b of [{ quietStart: 24 }, { maxListings: 0 }, { maxDigests: 13 }, { minGapMin: 10 }, { enabled: 'yes' }]) assert.equal((await h.call('PUT', '/api/alerts/prefs', b, u.cookie)).status, 400, JSON.stringify(b));
  const p = await h.call('PUT', '/api/alerts/prefs', { quietStart: 23, quietEnd: 7, maxListings: 10 }, u.cookie);
  assert.deepEqual([p.data.prefs.quietStart, p.data.prefs.quietEnd, p.data.prefs.maxListings, p.data.prefs.maxDigests], [23, 7, 10, 6]);
  const ids = [];
  for (let i = 0; i < 11; i++) ids.push((await h.repo.createArea({ name: 'Area ' + i, keywords: ['area' + i] }, NOW)).id);
  const other = (await h.repo.createArea({ name: 'Other', keywords: ['other'] }, NOW)).id;
  for (const id of ids) await h.repo.linkArea(u.user.id, id, NOW);
  assert.equal((await h.call('PUT', '/api/alerts/areas', { areas: [{ areaId: other }] }, u.cookie)).data.error, 'not_followed');
  assert.equal((await h.call('PUT', '/api/alerts/areas', { areas: ids.map(areaId => ({ areaId })) }, u.cookie)).data.error, 'too_many_areas');
  assert.equal((await h.call('PUT', '/api/alerts/areas', { areas: [{ areaId: ids[0], bhks: ['7'] }] }, u.cookie)).status, 400);
  assert.equal((await h.call('PUT', '/api/alerts/areas', { areas: [{ areaId: ids[0], maxRent: 5 }] }, u.cookie)).status, 400);
  const ok = await h.call('PUT', '/api/alerts/areas', { areas: [{ areaId: ids[0], maxRent: 30000, bhks: ['1RK', '2'] }, { areaId: ids[1] }] }, u.cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.areas, [{ areaId: ids[0], name: 'Area 0', maxRent: 30000, bhks: ['1RK', '2'] }, { areaId: ids[1], name: 'Area 1', maxRent: null, bhks: [] }]);
  assert.equal((await h.call('DELETE', `/api/areas/${ids[1]}`, undefined, u.cookie)).status, 204);
  assert.deepEqual((await h.call('GET', '/api/alerts/config', undefined, u.cookie)).data.areas.map(a => a.areaId), [ids[0]], 'unfollow removed the alert');
});

test('alerts API: endpoint allowlist (SSRF guard) and key checks', async () => {
  const h = await apiHarness();
  const u = await h.sessionFor('u@example.com');
  const bad = ['http://fcm.googleapis.com/fcm/send/x', 'https://localhost/push', 'https://127.0.0.1/push', 'https://[::1]/push', 'https://169.254.169.254/latest', 'https://evil.example.com/fcm',
    'https://fcm.googleapis.com:8443/fcm/send/x', 'https://user:pw@fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.com/x', 'https://push.apple.com.evil.com/x', 'https://' + 'a'.repeat(1100) + '.push.apple.com/x', 'not a url', ''];
  for (const e of bad) assert.equal((await h.call('POST', '/api/alerts/targets', sub(e), u.cookie)).status, 400, e);
  assert.equal((await h.call('POST', '/api/alerts/targets', sub(FCM(1), { p256dh: b64u(new Uint8Array(65)), auth: subKeys().auth }), u.cookie)).data.error, 'bad_keys', 'p256dh must start 0x04');
  assert.equal((await h.call('POST', '/api/alerts/targets', sub(FCM(1), { p256dh: subKeys().p256dh, auth: b64u(new Uint8Array(8)) }), u.cookie)).data.error, 'bad_keys');
  const good = [FCM(1), 'https://updates.push.services.mozilla.com/wpush/v2/gAAAA', 'https://web.push.apple.com/QGuQyavXutnMH', 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB', 'https://fcm.googleapis.com:443/fcm/send/y'];
  for (const e of good) assert.equal((await h.call('POST', '/api/alerts/targets', sub(e), u.cookie)).status, 201, e);
});

test('alerts API: 6th device replaces the oldest; a device moves to the account that registers it; no deleting others', async () => {
  const h = await apiHarness();
  const a = await h.sessionFor('a@example.com'), b = await h.sessionFor('b@example.com');
  const ids = [];
  for (let i = 1; i <= 6; i++) { ids.push((await h.call('POST', '/api/alerts/targets', sub(FCM(i)), a.cookie)).data.id); await new Promise(r => setTimeout(r, 2)); }
  let cfg = (await h.call('GET', '/api/alerts/config', undefined, a.cookie)).data;
  assert.equal(cfg.targets.length, 5); assert.ok(!cfg.targets.some(t => t.id === ids[0]));
  const moved = (await h.call('POST', '/api/alerts/targets', sub(FCM(6)), b.cookie)).data.id;
  assert.equal(moved, ids[5]);
  assert.equal((await h.call('DELETE', `/api/alerts/targets/${ids[1]}`, undefined, b.cookie)).status, 404, "another user's device");
  assert.equal((await h.call('DELETE', '/api/alerts/targets/abc', undefined, b.cookie)).status, 400);
  cfg = (await h.call('GET', '/api/alerts/config', undefined, a.cookie)).data;
  assert.equal(cfg.targets.length, 4);
});

test('no endpoint or key ever leaves the server: config and export', async () => {
  const h = await apiHarness();
  const u = await h.sessionFor('u@example.com');
  const endpoint = 'https://fcm.googleapis.com/fcm/send/SECRET-DEVICE-TOKEN-123';
  const s = sub(endpoint);
  await h.call('POST', '/api/alerts/targets', s, u.cookie);
  for (const p of ['/api/alerts/config', '/api/export']) {
    const r = await h.call('GET', p, undefined, u.cookie);
    assert.equal(r.status, 200);
    for (const secret of ['SECRET-DEVICE-TOKEN-123', s.subscription.keys.p256dh, s.subscription.keys.auth, h.env.VAPID_PRIVATE_KEY]) assert.ok(!r.text.includes(secret), `${p} leaks ${secret.slice(0, 12)}`);
  }
  const cfg = (await h.call('GET', '/api/alerts/config', undefined, u.cookie)).data;
  assert.deepEqual(Object.keys(cfg.targets[0]).sort(), ['channel', 'createdAt', 'failing', 'id', 'label', 'lastOkAt']);
});

// ---------- cron send step ----------
const T12 = Date.UTC(2026, 10, 8, 6, 30); // 12:00 IST
const ist = (h, m = 0) => Date.UTC(2026, 10, 8, 0, 0) - 5.5 * 36e5 + (h * 60 + m) * 60e3; // that IST clock time on 8 Nov

/** Mock push services: status per endpoint (default 201), every request recorded. */
function fakePush(statusFor = () => 201) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: statusFor(url) }); };
  return { fn, calls };
}
async function sendWorld({ alerts = { enabled: true, adminOnly: false }, adminEmails = '' } = {}) {
  const t = await memoryDb();
  const keys = await testVapid(); delete keys.publicKey;
  const env = { ...keys, ADMIN_EMAILS: adminEmails };
  const area = await t.repo.createArea(GREEN_GLEN, T12 - DAY);
  await t.repo.putSettings({ alerts });
  let n = 0;
  const addUser = async ({ email = `u${++n}@example.com`, endpoints = [`https://w${n}.notify.windows.com/w/?token=${n}`], prefs = {}, status = 'active', role = 'user' } = {}) => {
    const u = await t.repo.upsertUser({ email, role, status }, T12 - DAY);
    await t.repo.linkArea(u.id, area.id, T12 - DAY);
    await t.repo.replaceAlertAreas(u.id, [{ areaId: area.id }], T12 - DAY, DEFAULTS);
    if (Object.keys(prefs).length) await t.repo.putAlertPrefs(u.id, { ...(await t.repo.alertPrefs(u.id)), ...prefs }, T12 - DAY);
    for (const e of endpoints) await t.repo.upsertAlertTarget({ userId: u.id, channel: 'webpush', address: e, keys: {}, label: 'Test' }, T12 - DAY);
    return u;
  };
  const enqueue = async (userId, count, createdAt, status = 'pending', sentAt = null) => {
    for (let i = 0; i < count; i++) await t.db.run('INSERT INTO alert_queue (user_id, listing_id, area_id, status, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, `L${userId}-${createdAt}-${i}-${status}`, area.id, status, createdAt, sentAt]);
  };
  const rows = async userId => t.db.all('SELECT status, sent_at FROM alert_queue WHERE user_id = ? ORDER BY created_at, listing_id', [userId]);
  const step = (fetchFn, now = T12, opts = {}) => { const r = budgeted(t.repo); return alertStep(r, env, { fetchFn, now, ...opts }).then(s => ({ ...s, queries: r.used() })); };
  return { ...t, env, area, addUser, enqueue, rows, step };
}

test('quiet hours: IST conversion and wrap-around; held rows go out after quiet end as one digest', async () => {
  assert.deepEqual([istHourOf(ist(21, 59)), istHourOf(ist(22)), istHourOf(ist(7, 59)), istHourOf(ist(8))], [21, 22, 7, 8]);
  assert.deepEqual([21, 22, 23, 0, 7, 8].map(h => inQuiet(h, 22, 8)), [false, true, true, true, true, false]);
  assert.deepEqual([0, 1, 5, 6].map(h => inQuiet(h, 1, 6)), [false, true, true, false]);
  assert.equal(inQuiet(3, 5, 5), false, 'start == end: no quiet hours');
  assert.equal(istDayStart(ist(23, 30)), ist(0)); assert.equal(istDayStart(ist(0, 10)), ist(0));
  const w = await sendWorld();
  const u = await w.addUser();
  await w.enqueue(u.id, 1, ist(22, 5)); await w.enqueue(u.id, 2, ist(23, 40));
  const push = fakePush();
  assert.equal((await w.step(push.fn, ist(22, 10))).pushes, 0);
  assert.equal((await w.step(push.fn, ist(7, 59) + DAY)).pushes, 0);
  assert.equal(push.calls.length, 0, 'nothing during quiet hours');
  const r = await w.step(push.fn, ist(8, 0) + DAY);
  assert.equal(r.pushes, 1); assert.equal(push.calls.length, 1, 'one push for the whole night');
  const rs = await w.rows(u.id);
  assert.ok(rs.every(x => x.status === 'sent' && x.sent_at === ist(8, 0) + DAY), 'one batch');
});

test('caps: minimum gap, digests per day, listings per day (rows capped), admin ceiling, global pushes per day', async () => {
  const w = await sendWorld({ alerts: { enabled: true, adminOnly: false, maxListings: 5 } });
  const gap = await w.addUser(); await w.enqueue(gap.id, 1, T12 - 60e3); await w.enqueue(gap.id, 1, T12 - 30 * 60e3, 'sent', T12 - 30 * 60e3);
  const digests = await w.addUser({ prefs: { maxDigests: 2 } }); await w.enqueue(digests.id, 1, T12 - 60e3);
  for (const t of [ist(9), ist(10)]) await w.enqueue(digests.id, 1, t, 'sent', t);
  const listings = await w.addUser(); await w.enqueue(listings.id, 2, T12 - 60e3); await w.enqueue(listings.id, 5, ist(9), 'sent', ist(9)); // admin ceiling 5 < user 30
  const fine = await w.addUser(); await w.enqueue(fine.id, 1, T12 - 60e3); await w.enqueue(fine.id, 3, ist(9), 'sent', ist(9));
  const push = fakePush();
  const r = await w.step(push.fn);
  assert.equal(r.pushes, 1); assert.equal(push.calls.length, 1);
  assert.equal(new URL(push.calls[0].url).hostname, `w${4}.notify.windows.com`, 'only the user under every cap');
  assert.equal((await w.rows(gap.id))[1].status, 'pending', 'inside the 60-minute gap: waits');
  assert.equal((await w.rows(digests.id)).at(-1).status, 'pending', 'digest cap: waits for tomorrow');
  assert.deepEqual((await w.rows(listings.id)).filter(x => !x.sent_at).map(x => x.status), ['capped', 'capped'], 'listing cap: not pushed, still on #alerts');

  const g = await sendWorld({ alerts: { enabled: true, adminOnly: false, maxPushesPerDay: 1 } });
  const a = await g.addUser(), b = await g.addUser();
  await g.enqueue(a.id, 1, T12 - 120e3); await g.enqueue(b.id, 1, T12 - 60e3);
  const p2 = fakePush();
  assert.equal((await g.step(p2.fn)).pushes, 1);
  assert.equal((await g.step(p2.fn, T12 + 60e3)).pushes, 0, 'global daily cap reached');
  assert.equal(p2.calls.length, 1);
  assert.equal((await g.step(p2.fn, ist(8) + DAY)).pushes, 1, 'next IST day: allowed again');
});

test('send results: ok resets failures, 404/410 delete the device, 429 and 5xx keep rows pending, 403 counts a failure; 2 devices = 2 requests', async () => {
  const w = await sendWorld();
  const status = { 1: 201, 2: 410, 3: 404, 4: 429, 5: 403, 6: 500, 7: 500, 8: 201 };
  const ok = await w.addUser(); const gone410 = await w.addUser(); const gone404 = await w.addUser(); const slow = await w.addUser(); const denied = await w.addUser(); const down = await w.addUser();
  const mixed = await w.addUser({ endpoints: ['https://w7.notify.windows.com/w/?token=7', 'https://w8.notify.windows.com/w/?token=8'] });
  await w.db.run('UPDATE alert_targets SET failures = 3 WHERE user_id = ?', [ok.id]);
  for (const u of [ok, gone410, gone404, slow, denied, down, mixed]) await w.enqueue(u.id, 1, T12 - 60e3);
  const push = fakePush(url => status[new URL(url).hostname.match(/^w(\d+)/)[1]]);
  const r = await w.step(push.fn);
  assert.equal(push.calls.length, 8);
  assert.deepEqual([r.pushes, r.gone, r.failed], [2, 2, 3]);
  const targets = async u => w.db.all('SELECT failures, last_error, last_ok_at FROM alert_targets WHERE user_id = ? ORDER BY id', [u.id]);
  assert.deepEqual(await targets(ok), [{ failures: 0, last_error: null, last_ok_at: T12 }]);
  assert.deepEqual(await targets(gone410), []); assert.deepEqual(await targets(gone404), []);
  assert.deepEqual(await targets(slow), [{ failures: 0, last_error: null, last_ok_at: null }], '429 is not counted against the device');
  assert.deepEqual(await targets(denied), [{ failures: 1, last_error: 'http_403', last_ok_at: null }]);
  assert.deepEqual((await targets(mixed)).map(t => t.failures), [1, 0]);
  assert.equal((await w.rows(ok.id))[0].status, 'sent'); assert.equal((await w.rows(mixed.id))[0].status, 'sent', 'one device worked');
  assert.equal((await w.rows(slow.id))[0].status, 'pending'); assert.equal((await w.rows(down.id))[0].status, 'pending', 'retried next run');
  // Devices that failed 5 times are skipped.
  await w.db.run('UPDATE alert_targets SET failures = 5 WHERE user_id = ?', [down.id]);
  const again = fakePush();
  await w.step(again.fn, T12 + 2 * 36e5);
  assert.ok(!again.calls.some(c => c.url.includes('w6.')), 'dead device skipped');
  assert.equal((await w.rows(down.id))[0].status, 'capped', 'no working device: not pushed');
});

test('budget: 100 due users and 130 devices: <= 10 D1 queries and <= 40 pushes per run, oldest first, resumable; idle run is 2 queries', async () => {
  const w = await sendWorld();
  const users = [];
  for (let i = 0; i < 100; i++) {
    const n = users.length + 1;
    const endpoints = i < 30 ? [`https://a${n}.notify.windows.com/w/?t=${n}`, `https://b${n}.notify.windows.com/w/?t=${n}`] : [`https://a${n}.notify.windows.com/w/?t=${n}`];
    const u = await w.addUser({ endpoints }); users.push(u);
    await w.enqueue(u.id, 1, T12 - 60 * 60e3 + i * 1000);
  }
  const push = fakePush();
  const r1 = await w.step(push.fn);
  assert.ok(r1.queries <= 10, `run used ${r1.queries} queries`); assert.ok(push.calls.length <= 40, `${push.calls.length} pushes`);
  assert.equal(r1.users, 20, 'users 1-20 (two devices each) fill the 40 pushes');
  const sentIds = async () => (await w.db.all("SELECT DISTINCT user_id FROM alert_queue WHERE status = 'sent' ORDER BY user_id")).map(x => x.user_id);
  assert.deepEqual(await sentIds(), users.slice(0, 20).map(u => u.id));
  const r2 = await w.step(push.fn, T12 + 10 * 60e3);
  assert.ok(r2.queries <= 10); assert.equal(push.calls.length, 80);
  assert.equal(r2.users, 30, 'resumes in order: the last 10 two-device users, then 20 one-device users');
  assert.deepEqual(await sentIds(), users.slice(0, 50).map(u => u.id));
  let guard = 0; while ((await w.db.first("SELECT count(*) AS n FROM alert_queue WHERE status = 'pending'")).n && guard++ < 10) await w.step(push.fn, T12 + (guard + 2) * 10 * 60e3);
  assert.equal(push.calls.length, 130, 'every device got exactly one push');
  const idle = await sendWorld();
  const r = await idle.step(fakePush().fn);
  assert.deepEqual([r.action, r.queries], ['idle', 2]);
});

test('expiry: pending rows older than 36 h expire instead of being pushed', async () => {
  const w = await sendWorld();
  const u = await w.addUser();
  await w.enqueue(u.id, 1, T12 - 37 * 36e5); await w.enqueue(u.id, 1, T12 - 60e3);
  await w.step(fakePush().fn);
  assert.deepEqual((await w.rows(u.id)).map(x => x.status), ['expired', 'sent']);
});

test('kill switch, missing VAPID and admin-only soft launch in the send step', async () => {
  const off = await sendWorld({ alerts: { enabled: false } });
  const u0 = await off.addUser(); await off.enqueue(u0.id, 1, T12 - 60e3);
  const p0 = fakePush();
  assert.deepEqual([(await off.step(p0.fn)).action, p0.calls.length], ['off', 0]);
  const r = await alertStep(budgeted(off.repo), {}, { fetchFn: p0.fn, now: T12 });
  assert.deepEqual(r, { action: 'off', reason: 'not_configured' });
  const soft = await sendWorld({ alerts: { enabled: true }, adminEmails: 'boss@example.com' });
  const user = await soft.addUser(), boss = await soft.addUser({ email: 'boss@example.com' }), dbAdmin = await soft.addUser({ role: 'admin' });
  for (const u of [user, boss, dbAdmin]) await soft.enqueue(u.id, 1, T12 - 60e3);
  const p = fakePush();
  assert.equal((await soft.step(p.fn)).pushes, 2);
  assert.equal((await soft.rows(user.id))[0].status, 'pending', 'non-admin waits while adminOnly is on');
  const blocked = await soft.addUser({ email: 'boss2@example.com', role: 'admin', status: 'blocked' }); await soft.enqueue(blocked.id, 1, T12 - 60e3);
  const p2 = fakePush(); await soft.step(p2.fn, T12 + 36e5);
  assert.equal(p2.calls.length, 0, 'blocked accounts never receive');
});

test('send step CPU: 40 devices with mocked push services stay far under the 10 ms Workers budget (JS time)', async () => {
  let jsMs = Infinity; // best of 3 fresh runs: wall-clock time is noisy when the whole suite runs in parallel
  for (let attempt = 0; attempt < 3 && jsMs >= 15; attempt++) {
    const w = await sendWorld();
    for (let i = 0; i < 40; i++) { const u = await w.addUser(); await w.enqueue(u.id, 1, T12 - 60e3); }
    let dbMs = 0; const d = w.db;
    const timed = f => async (...a) => { const t = performance.now(); try { return await f(...a); } finally { dbMs += performance.now() - t; } };
    const repo = budgeted({ db: { ...d, all: timed(d.all), first: timed(d.first), run: timed(d.run), batch: timed(d.batch) } });
    const fetchFn = async () => new Response(null, { status: 201 });
    await alertStep(budgeted(w.repo), w.env, { fetchFn, now: T12 - 365 * DAY }); // warm-up (nothing due then is fine)
    const t0 = performance.now();
    const r = await alertStep(repo, w.env, { fetchFn, now: T12 });
    jsMs = Math.min(jsMs, performance.now() - t0 - dbMs);
    assert.equal(r.pushes, 40);
  }
  assert.ok(jsMs < 15, `alert step JS time ${jsMs.toFixed(2)} ms (target < 5 ms; loose ceiling for shared CI runners)`);
});

test('cron dispatch: */10 runs only the alert step; the hourly string runs the hourly job; unknown strings are ignored; wrangler.jsonc matches', async () => {
  const w = await sendWorld();
  const u = await w.addUser({ prefs: { quietStart: 0, quietEnd: 0 } }); await w.enqueue(u.id, 1, Date.now() - 60e3); // no quiet hours: runs on the real clock
  const push = fakePush();
  const app = createApp({ repo: () => w.repo, assets: async () => null, fetch: push.fn });
  const a = await app.scheduled({ cron: ALERT_CRON }, w.env);
  assert.equal(a.action, 'sent'); assert.equal(push.calls.length, 1);
  assert.equal((await w.repo.getSettings()).scheduler, undefined, 'hourly job did not run');
  const h = await app.scheduled({ cron: '30 * * * *' }, w.env);
  assert.equal(h.action, 'skipped', 'hourly job ran (no APIFY_TOKEN)'); assert.equal(push.calls.length, 1, 'alert step did not run again');
  assert.equal((await app.scheduled({ cron: '15 3 * * *' }, w.env)).action, 'ignored');
  assert.equal((await app.scheduled({}, w.env)).action, 'skipped', 'no cron string (tests, manual) = hourly job');
  const crons = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')).triggers.crons;
  assert.deepEqual(crons.filter(c => !HOURLY_CRONS.includes(c) && c !== ALERT_CRON), [], 'every Worker cron trigger is one scheduled() handles');
  assert.ok(crons.includes(ALERT_CRON));
});

// ---------- inbox and test send ----------
const LEAKY = ['Call 9876543210 now', 'WhatsApp +91-98765-43210', 'wa.me/919876543210', 'https://wa.me/919876543210?text=hi', 'tel:+919876543210',
  'location https://maps.app.goo.gl/AbC123', 'see https://www.facebook.com/groups/1/posts/77/', 'mail owner@example.com'];
const MOBILE = /(?<!\d)(?:\+?91|0)?[\s.-]{0,2}[6-9](?:[\s.-]{0,2}\d){9}(?!\d)/;

/** API harness plus a user who follows Green Glen with alerts on, one device, and a pushed batch of `n` listings. */
async function inboxWorld(n = 5) {
  const h = await apiHarness();
  const u = await h.sessionFor('u@example.com');
  const gg = await h.repo.createArea(GREEN_GLEN, Date.now());
  await h.repo.linkArea(u.user.id, gg.id, Date.now());
  assert.equal((await h.call('PUT', '/api/alerts/areas', { areas: [{ areaId: gg.id }] }, u.cookie)).status, 200);
  assert.equal((await h.call('POST', '/api/alerts/targets', sub(FCM(1)), u.cookie)).status, 201);
  // No quiet hours: these tests run alertStep on the real clock, which may fall in 22:00-08:00 IST.
  await h.repo.putAlertPrefs(u.user.id, { ...(await h.repo.alertPrefs(u.user.id)), quietStart: 0, quietEnd: 0 }, Date.now());
  const items = Array.from({ length: n }, (_, i) => ({ text: `${1 + (i % 3)}BHK available in Green Glen Layout, rent ${20000 + i * 1000}. ${LEAKY[i % LEAKY.length]}. At Sobha Elite Apartments. ${'abcdefghijklmnopq'[i]}xyz${i} unique words ${i}`,
    url: `https://www.facebook.com/groups/1/posts/${i}/`, author: 'Ravi Kumar', groupName: 'Bellandur Flats', createdAt: new Date(Date.now() - (i + 1) * 60e3).toISOString() }));
  await ingestItems(h.repo, items, { source: 'apify', storeAll: true });
  const push = fakePush();
  const st = await alertStep(budgeted(h.repo), h.env, { fetchFn: push.fn });
  assert.equal(st.pushes, 1);
  return { ...h, u, gg, push };
}

test('inbox: notification text uses only type, rent and area; no phones, emails, links, society, author or group; <= 3 lines + "+N more"', async () => {
  const w = await inboxWorld(5);
  const r = await w.call('GET', '/api/alerts/inbox', undefined, w.u.cookie);
  assert.equal(r.status, 200); assert.equal(r.data.count, 5);
  const n = r.data.notification;
  assert.equal(n.title, '5 new flats in your areas'); assert.equal(n.tag, 'flat-hunt-alerts');
  const lines = n.body.split('\n');
  assert.equal(lines.length, 4); assert.equal(lines[3], '+2 more');
  for (const l of lines.slice(0, 3)) assert.match(l, /^\d BHK · ₹\d{2},\d{3} · Green Glen$/, l);
  assert.equal(n.url, `/#area-${w.gg.id}`, 'one area: the homepage filtered to it');
  assert.doesNotMatch(r.text, MOBILE); assert.doesNotMatch(r.text, /@|https?:|wa\.me|tel:|maps|facebook|Sobha|Ravi|Bellandur Flats/i);
  // One listing: opens that listing.
  const one = alertText([{ listing_id: 'abc_123', area_id: 3, area_name: 'HSR Layout', bhk: '1RK', rent: 16500, type: null }]);
  assert.deepEqual(one, { title: 'New flat in HSR Layout', body: '1 RK · ₹16,500', url: '/#listing-abc_123', tag: 'flat-hunt-alerts' });
  assert.equal(alertText([{ listing_id: 'x', area_id: 3, area_name: 'HSR', type: 'pg' }]).title, 'New PG in HSR');
  const two = alertText([{ listing_id: 'a', area_id: 1, area_name: 'A', bhk: '2', rent: 1 }, { listing_id: 'b', area_id: 2, area_name: 'B', type: 'flatmate' }]);
  assert.equal(two.url, '/#alerts', 'several areas: the alerts list'); assert.equal(two.body, '2 BHK · ₹1 · A\nRoom · B');
  assert.equal(alertText([{ listing_id: '../x?y', area_id: 1 }]).url, '/#alerts', 'odd ids never reach the URL');
});

test('inbox: latest batch only; full=1 lists batches; generic after 24 h; public 401, pending 403, blocked 401', async () => {
  const w = await inboxWorld(2);
  // A second, newer batch of one listing.
  await ingestItems(w.repo, [{ text: '3BHK in Green Glen Layout near the lake, rent 52,000, call 9000099999 quietword', url: 'https://www.facebook.com/groups/1/posts/999/', createdAt: new Date(Date.now() - 30e3).toISOString() }], { source: 'apify', storeAll: true });
  await w.db.run('UPDATE alert_queue SET sent_at = sent_at - 7200000 WHERE status = \'sent\''); // first batch went out 2 h ago
  assert.equal((await alertStep(budgeted(w.repo), w.env, { fetchFn: fakePush().fn })).pushes, 1);
  const r = await w.call('GET', '/api/alerts/inbox', undefined, w.u.cookie);
  assert.equal(r.data.count, 1); assert.equal(r.data.notification.body, '3 BHK · ₹52,000'); assert.match(r.data.notification.url, /^\/#listing-[\w-]+$/);
  const full = await w.call('GET', '/api/alerts/inbox?full=1', undefined, w.u.cookie);
  assert.deepEqual(full.data.batches.map(b => b.items.length), [1, 2]);
  assert.ok(full.data.batches[0].items[0].posts, 'full listing for a signed-in user (via serializeListing)');
  assert.equal(full.data.batches[0].items[0].fp, undefined, 'storage internals stripped');
  await w.db.run('UPDATE alert_queue SET sent_at = sent_at - 2 * 86400000');
  assert.deepEqual((await w.call('GET', '/api/alerts/inbox', undefined, w.u.cookie)).data.notification, GENERIC_NOTE);
  assert.equal((await w.call('GET', '/api/alerts/inbox')).status, 401);
  const p = await w.sessionFor('p@example.com', 'user', 'pending');
  assert.equal((await w.call('GET', '/api/alerts/inbox', undefined, p.cookie)).status, 403);
  await w.repo.updateUser(w.u.user.id, { status: 'blocked' });
  assert.equal((await w.call('GET', '/api/alerts/inbox', undefined, w.u.cookie)).status, 401, 'blocked = signed out');
});

test('test send: one push per own device, inbox shows the test text for 10 minutes, 3 per hour, needs a device', async () => {
  const push = fakePush();
  const h = await apiHarness({ fetchFn: push.fn });
  const u = await h.sessionFor('u@example.com'), other = await h.sessionFor('o@example.com');
  assert.equal((await h.call('POST', '/api/alerts/test', undefined, u.cookie)).data.error, 'no_devices');
  await h.call('POST', '/api/alerts/targets', sub(FCM(1)), u.cookie);
  await h.call('POST', '/api/alerts/targets', sub('https://web.push.apple.com/QGuQyav'), u.cookie);
  await h.call('POST', '/api/alerts/targets', sub(FCM(9)), other.cookie);
  const r = await h.call('POST', '/api/alerts/test', undefined, u.cookie);
  assert.equal(r.status, 202); assert.deepEqual(r.data, { sent: 2, failed: 0 });
  assert.deepEqual(push.calls.map(c => c.url).sort(), [FCM(1), 'https://web.push.apple.com/QGuQyav'].sort(), "only the caller's devices");
  assert.deepEqual((await h.call('GET', '/api/alerts/inbox', undefined, u.cookie)).data.notification, TEST_NOTE);
  assert.equal((await h.call('POST', '/api/alerts/test', undefined, u.cookie)).status, 202);
  assert.equal((await h.call('POST', '/api/alerts/test', undefined, u.cookie)).status, 202);
  assert.equal((await h.call('POST', '/api/alerts/test', undefined, u.cookie)).status, 429, '4th test in an hour');
});

// ---------- service worker ----------
test('/sw.js and /alerts.js are served to the public with security headers; sw.js revalidates; CSP unchanged; no fetch handler', async () => {
  const t = await memoryDb();
  const app = createApp({ repo: () => t.repo, assets: staticAssets() });
  const env = { RUNTIME: 'worker', SESSION_SECRET: 'session-secret-0123456789abcdef0123', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'x', PUBLIC_BASE_URL: BASE };
  const sw = await app.fetch(new Request(BASE + '/sw.js'), env, {});
  assert.equal(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  assert.equal(sw.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
  assert.equal(sw.headers.get('x-content-type-options'), 'nosniff');
  const src = await sw.text();
  assert.doesNotMatch(src, /addEventListener\(\s*['"]fetch['"]/, 'no fetch handler: nothing is cached');
  assert.match(src, /\/api\/alerts\/inbox/);
  assert.equal((await app.fetch(new Request(BASE + '/alerts.js'), env, {})).status, 200, 'ui.js imports it: must load for the public too');
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, /script-src 'self';/); assert.doesNotMatch(csp, /worker-src|unsafe/);
});

// ---------- admin ----------
test('admin alerts: admin only, counts only, switches validated and stored, test goes to own devices only', async () => {
  const push = fakePush();
  const h = await apiHarness({ alerts: null, fetchFn: push.fn });
  const boss = await h.sessionFor('boss@example.com'), u = await h.sessionFor('u@example.com');
  for (const [m, p, b] of [['GET', '/api/admin/alerts'], ['PUT', '/api/admin/alerts', { enabled: true }], ['POST', '/api/admin/alerts/test']]) assert.equal((await h.call(m, p, b, u.cookie)).status, 403, `${m} ${p} for a user`);
  let v = (await h.call('GET', '/api/admin/alerts', undefined, boss.cookie)).data;
  assert.equal(v.configured, true); assert.equal(v.enabled, false); assert.equal(v.adminOnly, true, 'soft launch defaults');
  assert.deepEqual(v.defaults, { quietStart: 22, quietEnd: 8, maxListings: 30, maxDigests: 6, minGapMin: 60 });
  for (const b of [{ enabled: 'yes' }, { maxPushesPerDay: 50 }, { maxListings: 99 }, { quietEnd: -1 }]) assert.equal((await h.call('PUT', '/api/admin/alerts', b, boss.cookie)).status, 400, JSON.stringify(b));
  v = (await h.call('PUT', '/api/admin/alerts', { enabled: true, adminOnly: false, maxPushesPerDay: 500, maxListings: 20 }, boss.cookie)).data;
  assert.deepEqual([v.enabled, v.adminOnly, v.maxPushesPerDay, v.defaults.maxListings], [true, false, 500, 20]);
  assert.equal((await h.call('PUT', '/api/admin/alerts', { maxDigests: 4 }, boss.cookie)).data.enabled, true, 'partial update keeps the rest');
  // Users can now use alerts; the admin card counts them without naming anyone.
  const gg = await h.repo.createArea(GREEN_GLEN, Date.now()); await h.repo.linkArea(u.user.id, gg.id, Date.now());
  await h.call('PUT', '/api/alerts/areas', { areas: [{ areaId: gg.id }] }, u.cookie);
  await h.call('POST', '/api/alerts/targets', sub('https://fcm.googleapis.com/fcm/send/USER-DEVICE'), u.cookie);
  await h.call('POST', '/api/alerts/targets', sub('https://web.push.apple.com/BOSS-DEVICE'), boss.cookie);
  const r = await h.call('GET', '/api/admin/alerts', undefined, boss.cookie);
  assert.deepEqual([r.data.targets.webpush, r.data.usersWithAlerts, r.data.areasWithAlerts], [2, 1, 1]);
  assert.doesNotMatch(r.text, /DEVICE|example\.com|fcm\.googleapis|apple\.com/, 'no endpoints or emails');
  const t = await h.call('POST', '/api/admin/alerts/test', undefined, boss.cookie);
  assert.equal(t.status, 202); assert.deepEqual(t.data, { sent: 1, failed: 0 });
  assert.deepEqual(push.calls.map(c => c.url), ['https://web.push.apple.com/BOSS-DEVICE'], "only the admin's own device");
});

test('VAPID_SUBJECT that is not mailto: or https: keeps alerts idle and admin shows a clear status without the value (QA N3)', async () => {
  const h = await apiHarness();
  h.env.VAPID_SUBJECT = 'owner-secret-subject@example.com';
  const boss = await h.sessionFor('boss@example.com');
  const v = await h.call('GET', '/api/admin/alerts', undefined, boss.cookie);
  assert.equal(v.data.configured, false); assert.equal(v.data.configProblem, 'VAPID_SUBJECT must be mailto: or https:');
  assert.ok(!v.text.includes('owner-secret-subject'), 'value never printed');
  assert.equal((await h.call('GET', '/api/alerts/config', undefined, boss.cookie)).data.reason, 'not_configured');
  const push = fakePush();
  assert.deepEqual(await alertStep(budgeted(h.repo), h.env, { fetchFn: push.fn }), { action: 'off', reason: 'bad_subject' });
  assert.equal(push.calls.length, 0);
});
