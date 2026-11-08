// Reddit deleted-post clean-up (Data API terms) and the absence of any keyless Reddit mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redditCleanStep, redditPostId, resetRedditToken, toItem } from '../src/reddit.js';
import { ingestItems } from '../src/ingest.js';
import { scheduledJob, SCHEDULE_DEFAULTS } from '../src/apify.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const NOW = Date.UTC(2026, 10, 9, 10);
const SECRETS = { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec' };
const WORDS = ['tower', 'villa', 'corner', 'garden', 'lake', 'metro', 'school', 'market', 'temple', 'park'];
const post = (id, n) => toItem({ id, title: `${1 + n % 3}BHK for rent in Green Glen Layout, rent ${20000 + n * 1700}`, selftext: WORDS.map(w => w + 'q' + n + id).join(' '), permalink: `/r/bangalorerentals/comments/${id}/x/`, created_utc: NOW / 1000 - n * 3600, subreddit: 'bangalorerentals', author: 'someone' });
function api(handler) { const calls = []; return { calls, fn: async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); } }; }
const info = rows => Response.json({ data: { children: rows.map(d => ({ kind: 't3', data: d })) } });
const tokenOr = h => (url, init) => url.includes('access_token') ? Response.json({ access_token: 't', expires_in: 3600 }) : h(url, init);
async function setup(ids) {
  resetRedditToken();
  const t = await memoryDb(); await t.repo.createArea(GREEN_GLEN, NOW);
  await ingestItems(t.repo, ids.map((id, i) => post(id, i + 1)), { source: 'reddit', now: NOW, storeAll: true });
  return t;
}
const idsLeft = async t => (await t.repo.listListings()).flatMap(l => l.posts.map(p => redditPostId(p.url))).sort();
const run = (t, a, o = {}) => redditCleanStep(t.repo, SECRETS, { fetchFn: a.fn, now: NOW, settings: {}, budget: 30, ...o });

test('redditPostId reads the t3 id from the permalink', () => {
  assert.equal(redditPostId('https://www.reddit.com/r/x/comments/AbC12/title/'), 'abc12');
  assert.equal(redditPostId('https://www.facebook.com/groups/1/posts/2'), null);
});

test('clean-up removes deleted, removed and missing posts, keeps live ones, deletes empty listings', async () => {
  const t = await setup(['a1', 'a2', 'a3', 'a4']);
  assert.equal((await t.repo.listListings()).length, 4);
  const a = api(tokenOr(() => info([
    { id: 'a1', author: '[deleted]', selftext: 'text' },
    { id: 'a2', author: 'u', selftext: '[removed]' },
    // a3 missing from the response: kept
    { id: 'a4', author: 'u', selftext: 'still here' },
  ])));
  const r = await run(t, a);
  assert.equal(r.action, 'checked'); assert.equal(r.removed, 2); assert.equal(r.listingsDeleted, 2);
  assert.deepEqual(await idsLeft(t), ['a3', 'a4']);
  const infos = a.calls.filter(c => c.url.includes('/api/info'));
  assert.equal(infos.length, 1);
  assert.match(infos[0].url, /^https:\/\/oauth\.reddit\.com\/api\/info\?id=/);
  for (const id of ['a1', 'a2', 'a3', 'a4']) assert.ok(infos[0].url.includes('t3_' + id));
  assert.equal(infos[0].init.headers.authorization, 'Bearer t');
  // next tick finds nothing left and ends the cycle; then it is not due again for a day
  const s1 = await t.repo.getSettings();
  assert.equal((await run(t, a, { settings: s1 })).action, 'done');
  const s2 = await t.repo.getSettings();
  assert.equal((await run(t, a, { settings: s2, now: NOW + 3600e3 })).action, 'not_due');
  assert.equal((await run(t, a, { settings: s2, now: NOW + 24 * 3600e3 })).action, 'checked');
});

test('a listing with a live and a removed post keeps the live one', async () => {
  const t = await setup(['b1', 'b2']);
  const [x, y] = await t.repo.listListings();
  x.posts = [...x.posts, ...y.posts];
  await t.repo.saveIngest({ listings: [x], keys: [], run: null, now: NOW });
  await t.repo.deleteListings([y.id]);
  const a = api(tokenOr(() => info([{ id: 'b1', author: 'u', selftext: 'ok' }, { id: 'b2', author: 'u', selftext: '[deleted]' }])));
  const r = await run(t, a);
  assert.equal(r.removed, 1); assert.equal(r.listingsDeleted, 0);
  const left = await t.repo.listListings();
  assert.equal(left.length, 1); assert.equal(left[0].posts.length, 1);
});

test('clean-up: failed call keeps posts, low budget and missing secrets do nothing', async () => {
  const t = await setup(['c1']);
  const bad = api(tokenOr(() => new Response('x', { status: 500 })));
  await assert.rejects(() => run(t, bad), /HTTP 500/);
  assert.deepEqual(await idsLeft(t), ['c1']);
  const none = api(() => { throw new Error('no network expected'); });
  assert.equal((await run(t, none, { budget: 5 })).action, 'low_budget');
  assert.equal((await redditCleanStep(t.repo, {}, { fetchFn: none.fn, now: NOW, settings: {}, budget: 30 })).action, 'not_configured');
  assert.equal(none.calls.length, 0);
});

test('clean-up runs from the cron within the D1 budget', async () => {
  const t = await setup(['d1', 'd2']);
  const a = api(tokenOr(() => info([{ id: 'd1', author: '[deleted]', selftext: '' }, { id: 'd2', author: 'u', selftext: 'ok' }])));
  await t.repo.putSettings({ schedule: { ...SCHEDULE_DEFAULTS } });
  const st = await scheduledJob(t.repo, { ...SECRETS }, { fetchFn: a.fn, now: NOW });
  assert.equal(st.redditClean.removed, 1);
  assert.deepEqual(await idsLeft(t), ['d2']);
});

test('no public JSON mode: Reddit does not run without secrets and redditPublic is ignored', async () => {
  const t = await memoryDb(); await t.repo.createArea(GREEN_GLEN, NOW);
  await t.repo.putSettings({ schedule: { ...SCHEDULE_DEFAULTS, redditPublic: true } });
  const a = api(() => { throw new Error('no network expected'); });
  const st = await scheduledJob(t.repo, {}, { fetchFn: a.fn, now: NOW });
  assert.equal(a.calls.length, 0); assert.equal(st.reddit, undefined); assert.equal(st.redditClean, undefined);
  const mod = await import('../src/reddit.js');
  assert.equal(mod.redditPublicStep, undefined); assert.equal(mod.redditMode, undefined);
});

test('empty or partial 200 never deletes: only explicit signals remove posts', async () => {
  const t = await setup(['e1', 'e2']);
  const empty = api(tokenOr(() => info([])));
  await assert.rejects(() => run(t, empty), /no posts returned/);
  assert.deepEqual(await idsLeft(t), ['e1', 'e2']);
  assert.equal((await t.repo.getSettings()).redditClean, undefined, 'cursor unchanged');
  const partial = api(tokenOr(() => info([{ id: 'e1', author: 'u', selftext: 'ok' }])));
  const r = await run(t, partial);
  assert.equal(r.removed, 0); assert.deepEqual(await idsLeft(t), ['e1', 'e2']);
  const t2 = await setup(['f1', 'f2', 'f3']);
  const rm = api(tokenOr(() => info([{ id: 'f1', author: 'u', selftext: '', removed_by_category: 'moderator' }, { id: 'f2', author: '[deleted]', selftext: 'x' }, { id: 'f3', author: 'u', selftext: '[removed]' }])));
  assert.equal((await run(t2, rm)).removed, 3); assert.deepEqual(await idsLeft(t2), []);
});
