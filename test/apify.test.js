// Webhook auth, paged dataset ingest with resume, budget rule, run start and sweep (Apify API mocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { buildInput, webhookParam, runCost, OFFICIAL_ACTOR, DEFAULT_ACTOR, DATASET_OMIT } from '../src/apify.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const BASE = 'https://hunt.test';
const SECRET = 'ingest-secret-0123456789abcdef0123456789';
const ENV = { RUNTIME: 'worker', APP_PASSWORD: 'pw-pw-pw-pw-pw-pw', SESSION_SECRET: 'session-secret-0123456789abcdef0123', INGEST_SECRET: SECRET, APIFY_TOKEN: 'apify_api_TOKEN', PUBLIC_BASE_URL: 'https://hunt.test/' };

const post = (i, area = 'Green Glen') => ({ type: 'post', groupId: '111', text: `${1 + (i % 3)}BHK available in ${area}, rent ${20000 + i * 1000}. ${['tower', 'villa', 'corner', 'garden', 'lake', 'metro', 'school', 'market', 'temple', 'park'].map(w => w + 'x' + i).join(' ')}. Call 90000${String(10000 + i)}`, url: `https://www.facebook.com/groups/111/posts/${i}/`, source: 'https://www.facebook.com/groups/111/', createdAt: new Date(Date.UTC(2026, 10, 7) - i * 60e3).toISOString() });
const DATASET = [{ type: 'group', id: '111', name: 'Bellandur Flats', url: 'https://www.facebook.com/groups/111', privacy: 'public' }, ...Array.from({ length: 24 }, (_, i) => post(i))];

/** Fake Apify API. Records requests; `fail` can make a given request number throw. */
function fakeApify({ dataset = DATASET, usage = 1, limit = 5, runs = [], failOn = null } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url); calls.push({ url: u, init });
    assert.equal(init.headers?.Authorization, 'Bearer apify_api_TOKEN');
    if (failOn && failOn(u, calls.length)) return new Response('boom', { status: 500 });
    let m;
    if ((m = u.pathname.match(/^\/v2\/datasets\/(\w+)\/items$/))) {
      const off = +u.searchParams.get('offset'), lim = +u.searchParams.get('limit');
      return Response.json(dataset.slice(off, off + lim));
    }
    if (u.pathname === '/v2/users/me/limits') return Response.json({ data: { current: { monthlyUsageUsd: usage }, limits: { maxMonthlyUsageUsd: limit }, monthlyUsageCycle: { endAt: '2026-12-01T00:00:00Z' } } });
    if (u.pathname.match(/^\/v2\/acts\/[\w.~-]+\/runs$/) && init.method === 'POST') return Response.json({ data: { id: 'run0000NEW1', defaultDatasetId: 'dsNEW000001', startedAt: '2026-11-07T06:00:00Z' } });
    if (u.pathname.match(/^\/v2\/acts\/[\w.~-]+\/runs$/)) return Response.json({ data: { items: runs } });
    if (u.pathname.match(/^\/v2\/actor-runs\/\w+$/)) return Response.json({ data: { usageTotalUsd: 0.0002, chargedEventCounts: { 'apify-default-dataset-item': 0, 'apify-actor-start': 1 }, pricingInfo: { pricingPerEvent: { actorChargeEvents: { 'apify-default-dataset-item': { eventPriceUsd: 0.0012 }, 'apify-actor-start': { eventPriceUsd: 0.00005 } } } } } });
    return new Response('not found', { status: 404 });
  };
  return { fn, calls };
}
async function harness(apify, envOver = {}) {
  const t = await memoryDb();
  await t.repo.createArea(GREEN_GLEN, Date.now());
  const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: apify.fn });
  const env = { ...ENV, ...envOver };
  const hook = (body, headers = { 'x-ingest-secret': SECRET }) => app.fetch(new Request(BASE + '/api/ingest/apify', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env, {});
  return { ...t, app, env, hook };
}

test('webhook: wrong or missing secret is 401 and fetches nothing; disabled without INGEST_SECRET', async () => {
  const api = fakeApify(); const { hook } = await harness(api);
  assert.equal((await hook({ datasetId: 'dsAAAA0001' }, { 'x-ingest-secret': 'wrong' })).status, 401);
  assert.equal((await hook({ datasetId: 'dsAAAA0001' }, {})).status, 401);
  assert.equal(api.calls.length, 0);
  const off = await harness(fakeApify(), { INGEST_SECRET: '' });
  assert.equal((await off.hook({ datasetId: 'dsAAAA0001' })).status, 503);
});

test('webhook: body validation and 16 KB cap', async () => {
  const { hook } = await harness(fakeApify());
  assert.equal((await hook({ datasetId: '../../etc' })).status, 400);
  assert.equal((await hook({})).status, 400);
  assert.equal((await hook({ datasetId: 'dsAAAA0001', pad: 'x'.repeat(17 * 1024) })).status, 413);
  assert.equal((await hook('nope')).status, 400);
  assert.equal((await hook({ eventType: 'ACTOR.RUN.FAILED', datasetId: 'dsAAAA0001' })).status, 202);
});

test('webhook: ingests the dataset in pages; a replay of the same dataset is skipped', async () => {
  const api = fakeApify();
  const { hook, repo } = await harness(api, { INGEST_PAGE_SIZE: '10' });
  const r = await hook({ datasetId: 'dsAAAA0001', runId: 'runAAAA0001' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'done'); assert.equal(body.report.total, 24); assert.equal(body.report.newListings, 24);
  const pages = api.calls.filter(c => c.url.pathname.includes('/datasets/'));
  assert.deepEqual(pages.map(c => c.url.searchParams.get('offset')), ['0', '10', '20']);
  assert.ok(pages.every(c => c.url.searchParams.get('limit') === '10' && c.url.searchParams.get('clean') === 'true'));
  assert.deepEqual(pages[0].url.searchParams.get('omit').split(','), DATASET_OMIT);
  assert.equal((await repo.listListings())[0].posts[0].group, 'Bellandur Flats', 'group name from the group row on page 1 used on later pages');

  const again = await hook({ datasetId: 'dsAAAA0001', runId: 'runAAAA0001' });
  assert.deepEqual(await again.json(), { status: 'skipped', reason: 'already ingested' });
  assert.equal(api.calls.length, pages.length + 1, 'one run-cost lookup, then the replay makes no Apify calls');
  const runs = await repo.listRuns();
  assert.equal(runs.length, 1); assert.equal(runs[0].status, 'done'); assert.equal(runs[0].report.progress, undefined);
  assert.equal(runs[0].costUsd, 0.0303, '25 rows read x $0.0012 + start + platform usage');
  assert.deepEqual(runs[0].report.cost, { totalUsd: 0.0303, platformUsd: 0.0002, resultsUsd: 0.0301, rows: 25 });
  assert.equal((await repo.getSettings()).groupInfo.groups[0].name, 'Bellandur Flats', 'group details stored for runs without group rows');
});

test('paged ingest resumes from the saved offset after a failure, without double counting', async () => {
  let failed = false;
  const api = fakeApify({ failOn: u => u.pathname.includes('/datasets/') && u.searchParams.get('offset') === '10' && !failed && (failed = true) });
  const { hook, repo } = await harness(api, { INGEST_PAGE_SIZE: '10' });
  assert.equal((await hook({ datasetId: 'dsAAAA0002' })).status, 500);
  const mid = await repo.getRunByDataset('dsAAAA0002');
  assert.equal(mid.status, 'failed'); assert.equal(mid.report.progress.offset, 10); assert.equal(mid.report.newListings, 9, 'page 1 = group row + 9 posts');
  assert.equal((await repo.listListings()).length, 9);
  const r = await (await hook({ datasetId: 'dsAAAA0002' })).json();
  assert.equal(r.status, 'done'); assert.equal(r.report.total, 24); assert.equal(r.report.newListings, 24);
  const offsets = api.calls.filter(c => c.url.pathname.includes('/datasets/')).map(c => c.url.searchParams.get('offset'));
  assert.deepEqual(offsets, ['0', '10', '10', '20']);
  assert.equal((await repo.listListings()).length, 24);
});

test('scheduled: budget check, input from watched groups, exact cutoff = last successful start minus 15 min, caps, per-run webhook', async () => {
  const api = fakeApify({ usage: 1.2 });
  const { app, env, repo } = await harness(api);
  await repo.putSettings({ groups: [{ name: 'A', url: 'https://www.facebook.com/groups/111', active: true }, { name: 'B', url: 'https://www.facebook.com/groups/222', active: false }] });
  const lastStart = Date.UTC(2026, 10, 7, 2);
  await repo.recordStartedRun({ runId: 'runOLD00001', datasetId: 'dsOLD000001', startedAt: lastStart });
  await repo.claimRun({ datasetId: 'dsOLD000001', now: Date.now() });
  await repo.saveIngest({ listings: [], keys: [], run: { source: 'apify', datasetId: 'dsOLD000001', report: {} }, now: Date.now() });

  const st = await app.scheduled({}, env);
  assert.equal(st.action, 'started');
  const start = api.calls.find(c => c.init.method === 'POST');
  assert.equal(start.url.pathname, `/v2/acts/${DEFAULT_ACTOR}/runs`);
  assert.deepEqual(JSON.parse(start.init.body), { groups: ['https://www.facebook.com/groups/111'], resultsPerGroup: 30, sortOrder: 'new', postsPublishedAfter: '2026-11-07T01:45:00Z', includeGroupInfo: true });
  assert.equal(start.url.searchParams.get('maxItems'), '36', '1 group x 30 posts + 1 group row + 5');
  assert.equal(start.url.searchParams.get('maxTotalChargeUsd'), '0.06', 'the natural ceiling, below the $0.50 per-run limit');
  const hooks = JSON.parse(atob(start.url.searchParams.get('webhooks')));
  assert.deepEqual(hooks[0].eventTypes, ['ACTOR.RUN.SUCCEEDED']);
  assert.equal(hooks[0].requestUrl, 'https://hunt.test/api/ingest/apify');
  assert.deepEqual(JSON.parse(hooks[0].headersTemplate), { 'X-Ingest-Secret': SECRET });
  const s = await repo.getSettings();
  assert.equal(s.apifyUsage.usedUsd, 1.2); assert.equal(s.apifyUsage.limitUsd, 5); assert.equal(s.scheduler.action, 'started');
  assert.equal((await repo.getRunByDataset('dsNEW000001')).status, 'running');
});

test('scheduled: >80 % credit halves posts per group, >95 % skips the run', async () => {
  const half = fakeApify({ usage: 4.2 }); const h = await harness(half);
  await h.repo.putSettings({ groups: [{ name: 'A', url: 'https://www.facebook.com/groups/111', active: true }], resultsPerGroup: 30 });
  await h.app.scheduled({}, h.env);
  assert.equal(JSON.parse(half.calls.find(c => c.init.method === 'POST').init.body).resultsPerGroup, 15);

  const full = fakeApify({ usage: 4.9 }); const f = await harness(full);
  await f.repo.putSettings({ groups: [{ name: 'A', url: 'https://www.facebook.com/groups/111', active: true }] });
  const st = await f.app.scheduled({}, f.env);
  assert.equal(st.action, 'skipped'); assert.match(st.detail, /98% used/);
  assert.equal(full.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('scheduled: sweep ingests succeeded runs whose webhook was missed', async () => {
  const api = fakeApify({ runs: [{ id: 'runMISSED01', defaultDatasetId: 'dsMISSED001', startedAt: '2026-11-07T02:00:00Z', status: 'SUCCEEDED' }] });
  const { app, env, repo } = await harness(api);
  const st = await app.scheduled({}, env);
  assert.deepEqual(st.swept, [{ datasetId: 'dsMISSED001', status: 'done', newListings: 24 }]);
  assert.equal((await repo.getRunByDataset('dsMISSED001')).costUsd, 0.0303, 'swept runs get their cost too');
  assert.equal(st.action, 'skipped', 'no watched groups yet, so no new run');
  const st2 = await app.scheduled({}, env);
  assert.deepEqual(st2.swept, [], 'already ingested');
  assert.equal((await repo.getRunByDataset('dsMISSED001')).startedAt, Date.parse('2026-11-07T02:00:00Z'));
});

test('actor input builders and webhook param', () => {
  const args = { groups: [{ url: 'https://www.facebook.com/groups/1' }], resultsPerGroup: 20, after: Date.UTC(2026, 10, 6) };
  assert.deepEqual(buildInput(OFFICIAL_ACTOR, args), { startUrls: [{ url: 'https://www.facebook.com/groups/1' }], resultsLimit: 20, viewOption: 'CHRONOLOGICAL', onlyPostsNewerThan: '2026-11-06T00:00:00Z' });
  assert.deepEqual(buildInput(DEFAULT_ACTOR, { ...args, after: Date.UTC(2026, 10, 6, 7, 15, 30, 250) }), { groups: ['https://www.facebook.com/groups/1'], resultsPerGroup: 20, sortOrder: 'new', postsPublishedAfter: '2026-11-06T07:15:30Z', includeGroupInfo: false }, 'automly rejects milliseconds (HTTP 400, checked live 8 Nov)');
  assert.equal(buildInput(DEFAULT_ACTOR, { ...args, groupInfo: true }).includeGroupInfo, true);
  // Apify can report 0 charged rows right after a run: rows we read count instead.
  assert.deepEqual(runCost({ usageTotalUsd: 0.001, chargedEventCounts: { 'apify-default-dataset-item': 0 } }, DEFAULT_ACTOR, 100), { totalUsd: 0.121, platformUsd: 0.001, resultsUsd: 0.12, rows: 100 });
  assert.deepEqual(runCost({ usageTotalUsd: 0, chargedEventCounts: { post: 10 } }, OFFICIAL_ACTOR, 0), { totalUsd: 0.05, platformUsd: 0, resultsUsd: 0.05, rows: 10 });
  assert.equal(webhookParam({ INGEST_SECRET: 'x' }), null, 'no PUBLIC_BASE_URL, no webhook');
  assert.match(JSON.parse(atob(webhookParam({ INGEST_SECRET: 'x', PUBLIC_BASE_URL: 'https://a.b' })))[0].payloadTemplate, /resource.defaultDatasetId/);
});

test('settings show Apify usage and groups that could not be scraped', async () => {
  const rows = [...DATASET.slice(0, 3), { type: 'group', id: '999', name: 'Private Flats', url: 'https://www.facebook.com/groups/999', privacy: 'private' }];
  const api = fakeApify({ dataset: rows, usage: 2 });
  const { hook, app, env } = await harness(api);
  await hook({ datasetId: 'dsAAAA0003' });
  // a session cookie is needed for /api/settings in password mode
  const login = await app.fetch(new Request(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.APP_PASSWORD }) }), env, {});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const s = await (await app.fetch(new Request(BASE + '/api/settings', { headers: { cookie } }), env, {})).json();
  assert.deepEqual(s.unscrapableGroups.groups, [{ name: 'Private Flats', url: 'https://www.facebook.com/groups/999', reason: 'private' }]);
  assert.equal(s.apify.configured, true); assert.equal(s.apify.webhook, true);
  assert.equal(JSON.stringify(s).includes(SECRET), false, 'secrets never echoed');
  assert.equal(JSON.stringify(s).includes('apify_api_TOKEN'), false);
});

// ---------- QA regressions ----------
test('resume after a cut-off keeps group names from rows on earlier pages (QA)', async () => {
  let failed = false;
  const api = fakeApify({ failOn: u => u.pathname.includes('/datasets/') && u.searchParams.get('offset') === '10' && !failed && (failed = true) });
  const { hook, repo } = await harness(api, { INGEST_PAGE_SIZE: '10' });
  assert.equal((await hook({ datasetId: 'dsGRP000001' })).status, 500);
  assert.equal((await (await hook({ datasetId: 'dsGRP000001' })).json()).status, 'done');
  const groups = (await repo.listListings()).map(l => l.posts[0].group);
  assert.equal(groups.length, 24);
  assert.ok(groups.every(g => g === 'Bellandur Flats'), 'every post named by the group row on page 1: ' + [...new Set(groups)]);
});

test('a dataset longer than one invocation’s page budget is resumed, not marked done (QA)', async () => {
  const big = [DATASET[0], ...Array.from({ length: 130 }, (_, i) => post(i))];
  const api = fakeApify({ dataset: big });
  const { hook, repo } = await harness(api, { INGEST_PAGE_SIZE: '10' });
  const r1 = await hook({ datasetId: 'dsBIG000001' });
  assert.equal(r1.status, 503, 'partial ingest asks Apify to call again');
  assert.equal((await r1.json()).status, 'partial');
  const mid = await repo.getRunByDataset('dsBIG000001');
  assert.equal(mid.status, 'partial'); assert.equal(mid.report.progress.offset, 40);
  let last, calls = 1;
  do { last = await (await hook({ datasetId: 'dsBIG000001' })).json(); calls++; } while (last.status === 'partial' && calls < 10);
  assert.equal(last.status, 'done'); assert.equal(last.report.total, 130); assert.equal(calls, 4);
  assert.equal((await repo.listListings()).length, 130, 'nothing dropped, nothing doubled');
  assert.equal((await repo.getRunByDataset('dsBIG000001')).report.progress, undefined);
});

test('webhook and cron stay under the Workers Free cap of 50 D1 queries per invocation (QA)', async () => {
  const { memoryDb: mk } = await import('./helpers.js');
  const { createRepo } = await import('../src/db/repo.js');
  const t = await mk(); let n = 0;
  const counting = { ...t.db, all: (...a) => (n++, t.db.all(...a)), first: (...a) => (n++, t.db.first(...a)), run: (...a) => (n++, t.db.run(...a)), batch: l => (n += l.length, t.db.batch(l)) };
  const repo = createRepo(counting);
  await repo.createArea(GREEN_GLEN, Date.now());
  await repo.putSettings({ groups: [{ name: 'A', url: 'https://www.facebook.com/groups/111', active: true }] });
  const big = [DATASET[0], ...Array.from({ length: 300 }, (_, i) => post(i))];
  const api = fakeApify({ dataset: big, runs: [{ id: 'runSWEEP001', defaultDatasetId: 'dsSWEEP0001', startedAt: '2026-11-07T02:00:00Z' }, { id: 'runSWEEP002', defaultDatasetId: 'dsSWEEP0002', startedAt: '2026-11-07T06:00:00Z' }] });
  const app = createApp({ repo: () => repo, assets: async () => null, fetch: api.fn });
  n = 0;
  const r = await app.fetch(new Request(BASE + '/api/ingest/apify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': SECRET }, body: JSON.stringify({ datasetId: 'dsHOOK00001' }) }), ENV, {});
  assert.equal(r.status, 503);
  assert.ok(n <= 50, `webhook used ${n} D1 statements`);
  n = 0;
  const st = await app.scheduled({}, ENV);
  assert.equal(st.action, 'started', 'the new run starts even with a backlog to sweep');
  assert.equal(st.swept.length, 1, 'one dataset per cron');
  assert.ok(n <= 50, `cron used ${n} D1 statements`);
});

test('webhook while another invocation is ingesting the same dataset asks Apify to retry (QA)', async () => {
  const api = fakeApify();
  const { hook, repo } = await harness(api);
  await repo.claimRun({ datasetId: 'dsBUSY00001', now: Date.now() });
  const r = await hook({ datasetId: 'dsBUSY00001' });
  assert.equal(r.status, 503); assert.ok(r.headers.get('retry-after'));
  assert.equal((await r.json()).reason, 'in progress');
});

test('dataset reads never drop fields with fields=; only comment fields are omitted (QA)', async () => {
  const api = fakeApify();
  const { hook } = await harness(api);
  await hook({ datasetId: 'dsFLD000001' });
  const page = api.calls.find(c => c.url.pathname.includes('/datasets/')).url;
  assert.equal(page.searchParams.get('fields'), null);
  for (const f of page.searchParams.get('omit').split(',')) assert.match(f, /comments?/i, f + ' is ignored by the normaliser anyway');
});

test('default dataset page size is small enough for the 10 ms CPU budget (QA)', async () => {
  const { pageSize } = await import('../src/apify.js');
  assert.equal(pageSize({}), 15, 'v2 stores and fuzzy-matches every housing post: 25 posts ~10 ms JS, 15 ~4.5 ms');
});

test('invocation killed mid-dataset (CPU limit): lock expires after 5 min and the next attempt resumes exactly (QA)', async () => {
  const { ingestDataset } = await import('../src/apify.js');
  let failed = false;
  const api = fakeApify({ failOn: u => u.pathname.includes('/datasets/') && u.searchParams.get('offset') === '10' && !failed && (failed = true) });
  const { repo, db, env } = await harness(api, { INGEST_PAGE_SIZE: '10' });
  const T0 = Date.now();
  await assert.rejects(ingestDataset(repo, env, { datasetId: 'dsKILL00001' }, { fetchFn: api.fn, now: T0 }));
  // A killed isolate never reaches the catch block: the row stays 'ingesting' with its page-1 progress.
  await db.run(`UPDATE runs SET status = 'ingesting', at = ? WHERE dataset_id = ?`, [T0, 'dsKILL00001']);
  assert.deepEqual(await ingestDataset(repo, env, { datasetId: 'dsKILL00001' }, { fetchFn: api.fn, now: T0 + 60e3 }), { status: 'skipped', reason: 'in progress' });
  const r = await ingestDataset(repo, env, { datasetId: 'dsKILL00001' }, { fetchFn: api.fn, now: T0 + 6 * 60e3 });
  assert.equal(r.status, 'done'); assert.equal(r.report.total, 24); assert.equal(r.report.newListings, 24);
  assert.equal((await repo.listListings()).length, 24);
});

test('Apify 4xx errors include the reason from the response body, without the token', async () => {
  const { startRun: sr } = await import('../src/apify.js');
  const fetchFn = async (url) => url.includes('/users/me/limits')
    ? new Response(JSON.stringify({ data: { current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 5 } } }), { status: 200 })
    : new Response(JSON.stringify({ error: { type: 'invalid-input', message: 'Input is not valid: field postsPublishedAfter apify_api_SECRET' } }), { status: 400 });
  const repo = { getSettings: async () => ({ groups: [{ url: 'https://www.facebook.com/groups/111', active: true }] }), putSettings: async () => {}, lastSuccessfulStart: async () => null, lastGoodRun: async () => null, recordStartedRun: async () => {} };
  await assert.rejects(sr(repo, { APIFY_TOKEN: 't' }, { fetchFn }), e => /HTTP 400 \(invalid-input: Input is not valid/.test(e.message) && !/apify_api_SECRET/.test(e.message));
});

test('group details refresh even when unchanged, so they stop being stale (QA)', async () => {
  const api = fakeApify();
  const { hook, repo } = await harness(api, { INGEST_PAGE_SIZE: '50' });
  await repo.putSettings({ groups: [{ name: 'Bellandur', url: 'https://www.facebook.com/groups/111', active: true }] });
  await hook({ datasetId: 'dsGINFO0001', runId: 'runGINFO001' });
  const first = (await repo.getSettings()).groupInfo;
  await repo.putSettings({ groupInfo: { ...first, at: first.at - 8 * 864e5 } }); // a week later
  await hook({ datasetId: 'dsGINFO0002', runId: 'runGINFO002' }); // same group rows again
  const again = (await repo.getSettings()).groupInfo;
  assert.ok(again.at > first.at - 864e5, 'refreshed');
  assert.deepEqual(again.urls, ['https://www.facebook.com/groups/111']);
  assert.equal((await repo.listListings())[0].posts[0].group, 'Bellandur', "the admin's name for a watched group wins");
});

test('a run cut short by its limits is re-read once with the largest posts-per-group (QA)', async () => {
  const api = fakeApify({ usage: 1 });
  const { app, env, repo, hook } = await harness(api, { INGEST_PAGE_SIZE: '50' });
  await repo.putSettings({ groups: [{ name: 'A', url: 'https://www.facebook.com/groups/111', active: true }], resultsPerGroup: 10, groupInfo: { at: Date.now(), urls: ['https://www.facebook.com/groups/111'], groups: [] } });
  const after = Date.UTC(2026, 10, 7, 1);
  // A finished run that asked for 10 posts per group and got 24 from group A: it hit its limit.
  await repo.recordStartedRun({ runId: 'runCAP00001', datasetId: 'dsCAP000001', startedAt: Date.UTC(2026, 10, 7, 3), caps: { perGroup: 10, maxItems: 100, maxCharge: 0.5, after, recover: false } });
  await hook({ datasetId: 'dsCAP000001', runId: 'runCAP00001' });
  const run = await repo.getRunByDataset('dsCAP000001');
  assert.deepEqual(run.report.truncated.groups, ['A']); assert.equal(run.report.truncated.after, after);
  const st = await app.scheduled({}, env);
  assert.equal(st.action, 'started'); assert.match(st.detail, /re-reads its window with 50 posts per group/);
  const body = JSON.parse(api.calls.filter(c => c.init.method === 'POST').at(-1).init.body);
  assert.equal(body.resultsPerGroup, 50); assert.equal(body.postsPublishedAfter, '2026-11-07T01:00:00Z');
  assert.equal((await repo.getRunByDataset('dsNEW000001')).report.caps.recover, true, 'a second cut-short run is accepted, not re-read again');
});
