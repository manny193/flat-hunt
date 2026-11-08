// The Worker entry with a D1 stand-in (D1's prepare/bind/all/first/run/batch API over node:sqlite),
// so the d1Driver code path and env.ASSETS gating are exercised without wrangler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { openSqlite, migrateSqlite } from '../src/db/node-sqlite.js';
import { loadMigrations } from '../src/db/fs-migrations.js';
import { SAMPLES } from './helpers.js';

async function fakeD1() {
  const db = await openSqlite(':memory:');
  migrateSqlite(db, loadMigrations());
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })), success: true, meta: {} }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => {
      db.exec('BEGIN');
      try { const out = list.map(s => { const r = db.prepare(s.sql).run(...s.args); return { success: true, results: [], meta: { changes: Number(r.changes) } }; }); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
const ASSETS = { fetch: async req => new URL(req.url).pathname === '/' ? new Response('<!doctype html><title>Flat Hunt</title>', { headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404 }) };

test('Worker + D1: login, area, import, list, patch; assets only after login', async () => {
  const env = { DB: await fakeD1(), ASSETS, APP_PASSWORD: 'pw-0123456789abcdef', SESSION_SECRET: 'secret-0123456789abcdef0123456789', AUTH_DISABLED: '1' };
  const call = (method, path, body, cookie) => worker.fetch(new Request('https://flat-hunt.example.workers.dev' + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, {});
  assert.equal((await call('GET', '/api/listings')).status, 401, 'AUTH_DISABLED ignored by the Worker');
  assert.equal((await call('GET', '/')).status, 401, 'assets gated');
  const login = await call('POST', '/api/login', { password: env.APP_PASSWORD });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const home = await call('GET', '/', null, cookie);
  assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await call('POST', '/api/areas', { name: 'Green Glen' }, cookie)).status, 201);
  const imp = await (await call('POST', '/api/import', { source: 'manual', items: SAMPLES }, cookie)).json();
  assert.equal(imp.report.newListings, 6, 'every housing post is kept, matched or not'); assert.equal(imp.report.merged, 1);
  const again = await (await call('POST', '/api/import', { source: 'manual', items: SAMPLES }, cookie)).json();
  assert.equal(again.report.dupes, 7);
  const { listings } = await (await call('GET', '/api/listings', null, cookie)).json();
  assert.equal(listings.length, 5);
  const p = await (await call('PATCH', `/api/listings/${listings[0].id}`, { status: 'approved' }, cookie)).json();
  assert.equal(p.status, 'approved');
  assert.equal((await (await call('GET', '/healthz')).json()).ok, true);
});
