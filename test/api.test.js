// API happy paths and validation through the Fetch handler, node:sqlite in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { memoryDb, SAMPLES } from './helpers.js';

const BASE = 'https://radar.test';
async function harness(envOver = {}) {
  const t = await memoryDb();
  const app = createApp({ repo: () => t.repo, assets: async req => new URL(req.url).pathname === '/' || new URL(req.url).pathname === '/app.css' ? new Response('<!doctype html>ok', { headers: { 'content-type': 'text/html' } }) : null });
  const env = { RUNTIME: 'node', AUTH_DISABLED: '1', ...envOver };
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
    const res = await app.fetch(new Request(BASE + path, init), env, {});
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { ...t, app, env, call };
}

test('areas: create with generated keywords, edit, pause, rename, delete', async () => {
  const { call } = await harness();
  const a = await call('POST', '/api/areas', { name: 'Green Glen Layout' });
  assert.equal(a.status, 201); assert.deepEqual(a.data.keywords.slice(0, 4), ['green glen layout', 'greenglenlayout', 'green glen', 'greenglen']);
  assert.equal((await call('POST', '/api/areas', { name: 'green glen layout' })).status, 409, 'duplicate names refused');
  assert.equal((await call('POST', '/api/areas', { name: 'x' })).status, 400);
  const e = await call('PATCH', `/api/areas/${a.data.id}`, { keywords: 'Green Glen\nGG Layout', active: false });
  assert.deepEqual(e.data.keywords, ['green glen', 'gg layout']); assert.equal(e.data.active, false);
  const r = await call('PATCH', `/api/areas/${a.data.id}`, { name: 'Bellandur', regenerate: true });
  assert.equal(r.data.name, 'Bellandur'); assert.deepEqual(r.data.keywords, ['bellandur', 'bellandurr', 'belandur']);
  assert.equal((await call('GET', '/api/keywords?name=HSR%20Layout')).data.keywords[0], 'hsr layout');
  assert.equal((await call('DELETE', `/api/areas/${a.data.id}`)).status, 204);
  assert.deepEqual((await call('GET', '/api/areas')).data.areas, []);
});

test('import samples, list by status and area, patch, undo, delete', async () => {
  const { call } = await harness();
  const gg = (await call('POST', '/api/areas', { name: 'Green Glen' })).data;
  const wf = (await call('POST', '/api/areas', { name: 'Whitefield' })).data;
  const imp = await call('POST', '/api/import', { source: 'sample', items: SAMPLES });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.report.newListings, 5); assert.equal(imp.data.report.merged, 1); assert.equal(imp.data.report.offTopic, 1);
  const all = (await call('GET', '/api/listings')).data;
  assert.equal(all.listings.length, 5); assert.ok(all.listings.every(l => l.isSample && l.status === 'new'));
  assert.equal((await call('GET', `/api/listings?area=${gg.id}`)).data.listings.length, 5);
  assert.equal((await call('GET', `/api/listings?area=${wf.id}`)).data.listings.length, 0);

  const target = all.listings.find(l => l.rent === 48000);
  const p = await call('PATCH', `/api/listings/${target.id}`, { status: 'approved' });
  assert.equal(p.data.status, 'approved'); assert.equal(p.data.stage, 'To call'); assert.ok(p.data.decidedAt > 0);
  const s = await call('PATCH', `/api/listings/${target.id}`, { stage: 'Visit booked', notes: 'Owner: Mr Rao, 6pm' });
  assert.equal(s.data.stage, 'Visit booked'); assert.equal(s.data.decidedAt, p.data.decidedAt, 'stage change keeps decidedAt');
  assert.equal((await call('GET', '/api/listings?status=approved')).data.listings.length, 1);
  const u = await call('PATCH', `/api/listings/${target.id}`, { status: 'new', stage: '', decidedAt: null });
  assert.equal(u.data.status, 'new'); assert.equal(u.data.decidedAt, null);
  assert.equal((await call('PATCH', `/api/listings/${target.id}`, { status: 'maybe' })).status, 400);
  assert.equal((await call('PATCH', `/api/listings/${target.id}`, { stage: 'Bribed' })).status, 400);
  assert.equal((await call('PATCH', '/api/listings/nope', { status: 'approved' })).status, 404);

  // incremental refetch: only changed rows + all ids
  const since = (await call('GET', '/api/listings')).data.now;
  await call('PATCH', `/api/listings/${target.id}`, { status: 'rejected' });
  const inc = (await call('GET', `/api/listings?since=${since - 1}`)).data;
  assert.deepEqual(inc.listings.map(l => l.id), [target.id]); assert.equal(inc.ids.length, 5);

  assert.equal((await call('DELETE', '/api/listings?status=rejected')).data.deleted, 1);
  assert.equal((await call('DELETE', `/api/listings/${all.listings[0].id}`)).status, 204);
  assert.equal((await call('DELETE', '/api/listings?sample=1')).data.deleted, 3);
  assert.equal((await call('GET', '/api/listings')).data.listings.length, 0);
  const runs = (await call('GET', '/api/runs')).data.runs;
  assert.equal(runs.length, 1); assert.equal(runs[0].source, 'sample');
});

test('import validation: source, items, size cap, content type', async () => {
  const { call } = await harness();
  assert.equal((await call('POST', '/api/import', { source: 'evil', items: [{ text: 'x' }] })).status, 400);
  assert.equal((await call('POST', '/api/import', { source: 'manual', items: [] })).status, 400);
  const big = 'x'.repeat(2 * 1024 * 1024 + 10);
  assert.equal((await call('POST', '/api/import', { source: 'manual', items: [big] })).status, 413);
  assert.equal((await call('POST', '/api/import', 'source=manual', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call('POST', '/api/import', '{not json')).status, 400);
});

test('settings: structured watched groups, keyword filter, posts per group', async () => {
  const { call } = await harness();
  const s0 = (await call('GET', '/api/settings')).data;
  assert.deepEqual(s0.groups, []); assert.equal(s0.keywordFilter, true); assert.equal(s0.resultsPerGroup, 25); assert.equal(s0.apify.configured, false);
  const put = await call('PUT', '/api/settings', { groups: [{ name: 'Bellandur Flats', url: 'https://m.facebook.com/groups/123456/?ref=share', active: true }, { name: 'Old', url: 'https://www.facebook.com/groups/old-group/', active: false }], keywordFilter: false, resultsPerGroup: 30 });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data.groups, [{ name: 'Bellandur Flats', url: 'https://www.facebook.com/groups/123456', active: true }, { name: 'Old', url: 'https://www.facebook.com/groups/old-group', active: false }]);
  assert.equal(put.data.keywordFilter, false); assert.equal(put.data.resultsPerGroup, 30);
  assert.equal((await call('PUT', '/api/settings', { groups: [{ name: 'x', url: 'https://evil.example/groups/1' }] })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { groups: [{ name: 'x', url: 'javascript:alert(1)' }] })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { resultsPerGroup: 1000 })).status, 400);
  assert.equal((await call('PUT', '/api/settings', {})).status, 400);
});

test('security headers on every response, unknown routes 404, export download', async () => {
  const { call } = await harness();
  for (const path of ['/api/listings', '/api/nope', '/healthz', '/']) {
    const r = await call('GET', path);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
  }
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const ex = await call('GET', '/api/export');
  assert.match(ex.headers.get('content-disposition'), /attachment; filename="flat-radar-/);
  assert.deepEqual(ex.data.listings, []);
});

test('health reports minutes since the last Apify ingest, no listing data', async () => {
  const { call, repo } = await harness();
  assert.deepEqual((await call('GET', '/healthz')).data, { ok: true, lastIngestAgeMin: null });
  await repo.claimRun({ datasetId: 'ds12345678', now: Date.now() - 30 * 60e3 });
  await repo.saveIngest({ listings: [], keys: [], run: { source: 'apify', datasetId: 'ds12345678', report: {} }, now: Date.now() - 30 * 60e3 });
  const h = (await call('GET', '/healthz')).data;
  assert.equal(h.ok, true); assert.equal(h.lastIngestAgeMin, 30);
});
