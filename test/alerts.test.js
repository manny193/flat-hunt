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
