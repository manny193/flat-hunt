// Area alerts over Web Push (docs/ai/ALERTS-WEBPUSH.md): schema, repo, enqueue, API, send step, inbox.
// Every network call is mocked; VAPID keys are generated inside the tests, never real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, GREEN_GLEN } from './helpers.js';
import { openSqlite, migrateSqlite } from '../src/db/node-sqlite.js';
import { loadMigrations } from '../src/db/fs-migrations.js';
import { sqliteDriver } from '../src/db/drivers.js';
import { createRepo } from '../src/db/repo.js';

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
