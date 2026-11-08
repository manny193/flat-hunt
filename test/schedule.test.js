// Hourly cron: due check, data window, Pages left out, Reddit source (mocked), retention purge,
// area backfill, and the 50-queries-per-invocation budget with every step enabled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRepo } from '../src/db/repo.js';
import { cutoffFor, SCHEDULE_DEFAULTS, isDue, nextRunAt, istHourStart, apifyTime, groupInfoStale } from '../src/apify.js';
import { resetRedditToken, toItem, REDDIT_TOKEN_URL } from '../src/reddit.js';
import { ingestItems } from '../src/ingest.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const ENV = { RUNTIME: 'worker', SESSION_SECRET: 's'.repeat(40), APIFY_TOKEN: 'apify_api_TOKEN', INGEST_SECRET: 'i'.repeat(40), PUBLIC_BASE_URL: 'https://hunt.test' };
const H = 36e5;

function fakeApis({ redditPosts = {}, usage = 1 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url); calls.push({ url: u, init });
    if (url === REDDIT_TOKEN_URL) { assert.match(init.headers.authorization, /^Basic /); assert.match(init.headers['user-agent'], /^flat-hunt\/1\.0 by tester$/); return Response.json({ access_token: 'rtok', expires_in: 86400 }); }
    if (u.hostname === 'oauth.reddit.com') {
      assert.equal(init.headers.authorization, 'Bearer rtok');
      if (u.pathname === '/api/info') { const want = new Set(u.searchParams.get('id').split(',').map(x => x.replace('t3_', ''))); return Response.json({ data: { children: Object.values(redditPosts).flat().filter(d => want.has(d.permalink.split('/')[4])).map(d => ({ kind: 't3', data: { ...d, id: d.permalink.split('/')[4] } })) } }); }
      const sub = u.pathname.split('/')[2];
      return Response.json({ data: { children: (redditPosts[sub] || []).map(d => ({ kind: 't3', data: d })) } });
    }
    if (u.pathname === '/v2/users/me/limits') return Response.json({ data: { current: { monthlyUsageUsd: usage }, limits: { maxMonthlyUsageUsd: 5 } } });
    if (/\/v2\/acts\/.+\/runs$/.test(u.pathname) && init.method === 'POST') return Response.json({ data: { id: 'run' + calls.length + 'XXXXXX', defaultDatasetId: 'ds' + calls.length + 'XXXXXXX', startedAt: new Date().toISOString() } });
    if (/\/v2\/acts\/.+\/runs$/.test(u.pathname)) return Response.json({ data: { items: [] } });
    return new Response('nf', { status: 404 });
  };
  return { fn, calls };
}
function counting(t) {
  let n = 0;
  const c = { ...t.db, all: (...a) => (n++, t.db.all(...a)), first: (...a) => (n++, t.db.first(...a)), run: (...a) => (n++, t.db.run(...a)), batch: l => (n += l.length, t.db.batch(l)) };
  return { repo: createRepo(c), count: () => n, reset: () => { n = 0; } };
}
const rpost = (i, sub, ageH, text) => ({ id: 'p' + sub + i, title: text || `${1 + (i % 3)}BHK for rent in Green Glen Layout, rent ${20000 + i * 1000}`, selftext: text ? '' : ['tower', 'villa', 'corner', 'garden', 'lake', 'metro', 'school', 'market', 'temple', 'park'].map(w => w + 'x' + i + sub.length).join(' '), permalink: `/r/${sub}/comments/${i}/x/`, created_utc: (Date.now() - ageH * H) / 1000, subreddit: sub, author: 'someone' });

test('cron is hourly: a scrape starts only when due; Pages are left out of the actor input', async () => {
  const t = await memoryDb(); await t.repo.createArea(GREEN_GLEN, Date.now());
  await t.repo.putSettings({ groups: [{ name: 'Page', url: 'https://www.facebook.com/FindMyRoomBangalore', active: true, kind: 'page' }, { name: 'G', url: 'https://www.facebook.com/groups/111', active: true }] });
  const api = fakeApis(); const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: api.fn });
  const now = Date.now();
  const first = await app.scheduled({}, ENV);
  assert.equal(first.action, 'started'); assert.match(first.detail, /Skipped 1 Facebook Page/);
  const body = JSON.parse(api.calls.find(c => c.init.method === 'POST').init.body);
  assert.deepEqual(body.groups, ['https://www.facebook.com/groups/111']);
  assert.ok(Date.parse(body.postsPublishedAfter) >= now - 3 * 24 * H - 1000, 'never more than backfillDays on the first run');
  assert.match(body.postsPublishedAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'exact time, no milliseconds');
  const second = await app.scheduled({}, ENV);
  assert.equal(second.action, 'not_due'); assert.equal(api.calls.filter(c => c.init.method === 'POST').length, 1);
  assert.ok(second.nextRunAt > now && second.nextRunAt <= now + 10 * H, 'next IST run hour');
  await t.repo.putSettings({ schedule: { ...SCHEDULE_DEFAULTS, enabled: false } });
  assert.equal((await app.scheduled({}, ENV)).action, 'paused');
});

test('data window: cutoff = max(last good start - 15 min, now - backfillDays), sent without milliseconds', () => {
  const now = Date.UTC(2026, 10, 10);
  assert.equal(cutoffFor(null, { backfillDays: 3 }, now), now - 3 * 24 * H);
  assert.equal(cutoffFor(now - 2 * H, { backfillDays: 3 }, now), now - 2 * H - 15 * 60e3);
  assert.equal(apifyTime(Date.UTC(2026, 10, 8, 5, 4, 3, 999)), '2026-11-08T05:04:03Z');
  assert.equal(cutoffFor(now - 10 * 24 * H, { backfillDays: 2 }, now), now - 2 * 24 * H, 'after an outage');
  assert.equal(cutoffFor(null, { backfillDays: 99 }, now), now - 5 * 24 * H, 'capped at 5 days');
  assert.equal(cutoffFor(now - 2 * H, { backfillDays: 3, overlapMin: 5 }, now), now - 2 * H - 5 * 60e3, 'overlapMin lowers the overlap (fewer rows bought twice)');
  assert.equal(cutoffFor(now - 2 * H, { backfillDays: 3, overlapMin: 0 }, now), now - 2 * H - 15 * 60e3, 'out of range: the 15 min default');
});

test('admin schedule: overlapMin is validated (1-60) and stored', async () => {
  const t = await memoryDb();
  const app = createApp({ repo: () => t.repo, assets: async () => null });
  const put = body => app.fetch(new Request('https://hunt.test/api/admin/scraper', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { RUNTIME: 'node', AUTH_DISABLED: '1' }, {});
  assert.equal((await put({ overlapMin: 0 })).status, 400);
  assert.equal((await put({ overlapMin: 61 })).status, 400);
  const ok = await put({ overlapMin: 5 });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).schedule.overlapMin, 5);
});

test('IST run hours: due once per listed hour, next run is the next listed hour; interval mode still works', () => {
  const ist = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m) - 5.5 * H; // IST wall clock -> ms
  const sch = { ...SCHEDULE_DEFAULTS, runHoursIst: [6, 9, 21] };
  assert.equal(isDue(sch, null, ist(10, 3)), true, 'never run: start now');
  assert.equal(isDue(sch, ist(10, 6), ist(10, 9, 1)), true, '9 AM slot');
  assert.equal(isDue(sch, ist(10, 9, 1), ist(10, 9, 30)), false, 'already ran in this hour');
  assert.equal(isDue(sch, ist(10, 9), ist(10, 10)), false, '10 AM is not a run hour');
  assert.equal(istHourStart(ist(10, 9, 42)), ist(10, 9));
  assert.equal(nextRunAt({ schedule: sch, scheduler: { lastStartedAt: ist(10, 9) } }, ist(10, 10)), ist(10, 21));
  assert.equal(nextRunAt({ schedule: sch, scheduler: { lastStartedAt: ist(10, 21) } }, ist(10, 22)), ist(11, 6), 'wraps to tomorrow');
  const iv = { ...SCHEDULE_DEFAULTS, mode: 'interval', intervalHours: 4 };
  assert.equal(isDue(iv, ist(10, 9), ist(10, 12)), false); assert.equal(isDue(iv, ist(10, 9), ist(10, 13)), true);
  assert.equal(isDue({ ...sch, enabled: false }, null, ist(10, 9)), false);
});

test('group details are fetched only when stale (a week) or when a watched group is new', () => {
  const now = Date.UTC(2026, 10, 10); const g = [{ url: 'https://www.facebook.com/groups/1' }];
  assert.equal(groupInfoStale({}, g, now), true);
  assert.equal(groupInfoStale({ groupInfo: { at: now - 864e5, urls: ['https://www.facebook.com/groups/1'] } }, g, now), false);
  assert.equal(groupInfoStale({ groupInfo: { at: now - 8 * 864e5, urls: ['https://www.facebook.com/groups/1'] } }, g, now), true);
  assert.equal(groupInfoStale({ groupInfo: { at: now, urls: [] } }, g, now), true);
});

test('Reddit: OAuth client_credentials, /new and search, cutoff + watermark, runs recorded as source reddit', async () => {
  resetRedditToken();
  const t = await memoryDb(); await t.repo.createArea(GREEN_GLEN, Date.now());
  await t.repo.putSettings({ subreddits: [{ name: 'bangalorerentals' }, { name: 'bangalore', query: 'flat OR rent' }] });
  const posts = { bangalorerentals: [rpost(1, 'bangalorerentals', 1), rpost(2, 'bangalorerentals', 5), rpost(3, 'bangalorerentals', 24 * 4)], bangalore: [rpost(4, 'bangalore', 2), rpost(5, 'bangalore', 3, 'Selling my bicycle, barely used')] };
  const api = fakeApis({ redditPosts: posts });
  const env = { ...ENV, APIFY_TOKEN: '', REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USERNAME: 'tester' };
  const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: api.fn });
  const st = await app.scheduled({}, env);
  assert.equal(st.reddit.action, 'done'); assert.equal(st.reddit.fetched, 4, 'the 4-day-old post is outside the 3-day window');
  const search = api.calls.find(c => c.url.pathname === '/r/bangalore/search');
  assert.equal(search.url.searchParams.get('restrict_sr'), '1'); assert.equal(search.url.searchParams.get('sort'), 'new');
  const runs = await t.repo.listRuns(5, { source: 'reddit' });
  assert.equal(runs.length, 1); assert.equal(runs[0].status, 'done'); assert.equal(runs[0].report.newListings, 3); assert.equal(runs[0].report.notHousing, 1);
  const l = (await t.repo.listListings()).find(x => x.groups.includes('r/bangalorerentals'));
  assert.match(l.posts[0].url, /^https:\/\/www\.reddit\.com\/r\/bangalorerentals\/comments\//);
  assert.equal((await app.scheduled({}, env)).reddit.action, 'not_due');
  const s = await t.repo.getSettings();
  await t.repo.putSettings({ reddit: { ...s.reddit, lastStartedAt: Date.now() - 5 * H } });
  posts.bangalorerentals.unshift(rpost(9, 'bangalorerentals', 0.1));
  const again = await app.scheduled({}, env);
  assert.equal(again.reddit.fetched, 1, 'watermark: only the post newer than the last one seen');
  assert.deepEqual(toItem({ title: 'T', selftext: 'B', permalink: '/r/x/comments/1/', created_utc: 0, subreddit: 'x', author: '[deleted]' }).author, '');
});

test('Reddit not connected: no calls, shown as not connected', async () => {
  const t = await memoryDb(); const api = fakeApis();
  const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: api.fn });
  const st = await app.scheduled({}, { ...ENV, APIFY_TOKEN: '' });
  assert.equal(st.reddit, undefined); assert.equal(api.calls.length, 0);
});

test('retention: daily purge drops old listings unless someone shortlisted them', async () => {
  const t = await memoryDb(); await t.repo.createArea(GREEN_GLEN, Date.now());
  const old = Date.now() - 40 * 24 * H;
  await ingestItems(t.repo, [{ text: '2BHK in Green Glen Layout for rent 20000 alpha', url: 'https://www.facebook.com/groups/1/posts/1/', createdAt: new Date(old).toISOString() }, { text: '3BHK in Green Glen Layout for rent 40000 beta gamma', url: 'https://www.facebook.com/groups/1/posts/2/', createdAt: new Date(old).toISOString() }, { text: '1BHK in Green Glen Layout for rent 15000 fresh', url: 'https://www.facebook.com/groups/1/posts/3/' }], { source: 'apify', storeAll: true, now: Date.now() });
  const u = await t.repo.upsertUser({ email: 'k@example.com' }, Date.now());
  const keep = (await t.repo.listListings()).find(l => l.rent === 40000);
  await t.repo.updateListingFields(keep.id, { status: 'approved', stage: 'To call', notes: '', decidedAt: 1 }, Date.now(), u.id);
  const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: fakeApis().fn });
  const st = await app.scheduled({}, { ...ENV, APIFY_TOKEN: '' });
  assert.equal(st.purged, 1);
  assert.deepEqual((await t.repo.listListings()).map(l => l.rent).sort(), [15000, 40000]);
  assert.equal((await t.repo.lookupKeys(['u:facebook.com/groups/1/posts/1'])).size, 0, 'post keys purged too');
  assert.equal((await app.scheduled({}, { ...ENV, APIFY_TOKEN: '' })).purged, undefined, 'once a day');
});

test('every cron step together stays under 50 D1 queries per invocation', async () => {
  resetRedditToken();
  const t = await memoryDb(); const c = counting(t);
  await c.repo.createArea(GREEN_GLEN, Date.now());
  await c.repo.putSettings({ groups: [{ name: 'G', url: 'https://www.facebook.com/groups/111', active: true }], areaBackfill: { 1: { next: 0, max: 50000, startedAt: 1 } } });
  const posts = { bangalorerentals: Array.from({ length: 100 }, (_, i) => rpost(i, 'bangalorerentals', 0.5 + i * 0.1)) };
  const env = { ...ENV, REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USERNAME: 'tester' };
  // Interval mode keeps this independent of the time of day (IST run hours would vary the steps run).
  await c.repo.putSettings({ subreddits: [{ name: 'bangalorerentals' }], scheduler: { lastStartedAt: Date.now() - H }, schedule: { ...SCHEDULE_DEFAULTS, mode: 'interval' } });
  const app = createApp({ repo: () => c.repo, assets: async () => null, fetch: fakeApis({ redditPosts: posts }).fn });
  for (let i = 0; i < 4; i++) {
    c.reset();
    const st = await app.scheduled({}, env);
    assert.ok(c.count() <= 50, `invocation ${i} used ${c.count()} D1 statements`);
    if (i === 0) assert.equal(st.reddit.action, 'continuing', '100 posts take several invocations');
  }
  const runs = await c.repo.listRuns(5, { source: 'reddit' });
  assert.ok(runs[0].report.newListings > 50, JSON.stringify(runs[0].report).slice(0, 300));
});

// QA round 2: worst hour. Scrape due, an unfinished Apify dataset to sweep, Reddit backlog, AI queue,
// area backfill and the daily purge all at once, plus the webhook with AI enrich after it.
test('worst-case hour (sweep backlog + Reddit + AI + backfill + purge) stays under 50 D1 statements (QA)', async () => {
  resetRedditToken();
  const t = await memoryDb(); const c = counting(t);
  await c.repo.createArea(GREEN_GLEN, Date.now());
  // Existing listings for the AI queue and the purge.
  await ingestItems(c.repo, Array.from({ length: 40 }, (_, i) => ({ text: `${1 + (i % 3)}BHK for rent in Green Glen Layout rent ${20000 + i * 500} word${i}q call 98${String(10000000 + i)}`, url: `https://www.facebook.com/groups/1/posts/a${i}/` })), { source: 'manual', now: Date.now() - 2 * H });
  const ds = Array.from({ length: 300 }, (_, i) => ({ type: 'post', text: `2BHK available in Green Glen Layout, rent ${30000 + i * 100}. unique${i}zz call 97${String(10000000 + i)}`, url: `https://www.facebook.com/groups/2/posts/d${i}/`, createdAt: new Date().toISOString() }));
  const base = fakeApis({ redditPosts: { bangalorerentals: Array.from({ length: 100 }, (_, i) => rpost(i, 'bangalorerentals', 0.5 + i * 0.1)) } });
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    if (/\/v2\/acts\/.+\/runs$/.test(u.pathname) && init.method !== 'POST') return Response.json({ data: { items: [{ id: 'runBACKLOG1', defaultDatasetId: 'dsBACKLOG01', startedAt: new Date(Date.now() - H).toISOString() }] } });
    if (/\/v2\/datasets\/.+\/items$/.test(u.pathname)) { const off = +u.searchParams.get('offset'), lim = +u.searchParams.get('limit'); return Response.json(ds.slice(off, off + lim)); }
    return base.fn(url, init);
  };
  const AI = { run: async (model, { messages }) => { const ids = [...messages.at(-1).content.matchAll(/id="(P\d+)"/g)].map(m => m[1]); return { response: JSON.stringify({ results: ids.map(id => ({ id, isRental: true, kind: 'offer', type: 'flat', bhk: null, rent: null, deposit: null, depositMonths: null, maintenance: null, brokerage: null, brokerageAmount: null, furnishing: null, gender: null, availableFrom: null, society: null, locality: null, otherUnits: [], summary: 'x', confidence: 0.9 })) }) }; } };
  const env = { ...ENV, AI, REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USERNAME: 'tester' };
  await c.repo.putSettings({ groups: [{ name: 'G', url: 'https://www.facebook.com/groups/111', active: true }], subreddits: [{ name: 'bangalorerentals' }], areaBackfill: { 1: { next: 0, max: 50000, startedAt: 1 } }, scheduler: { lastStartedAt: Date.now() - 2 * H }, schedule: { ...SCHEDULE_DEFAULTS, mode: 'interval', intervalHours: 1 } });
  const app = createApp({ repo: () => c.repo, assets: async () => null, fetch: fn });
  for (let i = 0; i < 3; i++) {
    c.reset();
    const st = await app.scheduled({}, env);
    assert.ok(c.count() <= 50, `cron invocation ${i} used ${c.count()} D1 statements: ${JSON.stringify({ a: st.action, sw: st.swept, r: st.reddit?.action, ai: st.ai?.action, b: !!st.backfill, p: st.purged })}`);
  }
  // Webhook for a fresh dataset, with AI enrich in waitUntil counted in the same invocation.
  c.reset(); const waits = [];
  const r = await app.fetch(new Request('https://hunt.test/api/ingest/apify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': ENV.INGEST_SECRET }, body: JSON.stringify({ datasetId: 'dsHOOKQA001' }) }), env, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.ok([200, 503].includes(r.status));
  assert.ok(c.count() <= 50, `webhook + enrich used ${c.count()} D1 statements`);
});
