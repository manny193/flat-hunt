// Hourly cron: due check, data window, Pages left out, Reddit source (mocked), retention purge,
// area backfill, and the 50-queries-per-invocation budget with every step enabled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRepo } from '../src/db/repo.js';
import { cutoffFor, SCHEDULE_DEFAULTS } from '../src/apify.js';
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
  const second = await app.scheduled({}, ENV);
  assert.equal(second.action, 'not_due'); assert.equal(api.calls.filter(c => c.init.method === 'POST').length, 1);
  assert.ok(second.nextRunAt > now + 3.9 * H);
  await t.repo.putSettings({ schedule: { ...SCHEDULE_DEFAULTS, enabled: false } });
  assert.equal((await app.scheduled({}, ENV)).action, 'paused');
});

test('data window: cutoff = max(last good start - 1 h, now - backfillDays)', () => {
  const now = Date.UTC(2026, 10, 10);
  assert.equal(cutoffFor(null, { backfillDays: 3 }, now), now - 3 * 24 * H);
  assert.equal(cutoffFor(now - 2 * H, { backfillDays: 3 }, now), now - 3 * H);
  assert.equal(cutoffFor(now - 10 * 24 * H, { backfillDays: 2 }, now), now - 2 * 24 * H, 'after an outage');
  assert.equal(cutoffFor(null, { backfillDays: 99 }, now), now - 5 * 24 * H, 'capped at 5 days');
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
  await c.repo.putSettings({ subreddits: [{ name: 'bangalorerentals' }], scheduler: { lastStartedAt: Date.now() - H } });
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
