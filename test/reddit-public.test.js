// Reddit public JSON mode (no API key): endpoint, headers, cursor, block handling, backoff, budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRepo } from '../src/db/repo.js';
import { redditPublicStep, PUBLIC_UA, resetRedditToken, REDDIT_TOKEN_URL } from '../src/reddit.js';
import { SCHEDULE_DEFAULTS } from '../src/apify.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const H = 36e5;
const ENV = { RUNTIME: 'worker', SESSION_SECRET: 's'.repeat(40), INGEST_SECRET: 'i'.repeat(40) };
const rpost = (i, sub, ageH) => ({ id: 'p' + sub + i, title: `${1 + (i % 3)}BHK for rent in Green Glen Layout, rent ${20000 + i * 1000}`, selftext: ['tower', 'villa', 'corner', 'garden', 'lake', 'metro', 'school', 'market', 'temple', 'park'].map(w => w + 'x' + i + sub.length).join(' '), permalink: `/r/${sub}/comments/${i}/x/`, created_utc: (Date.now() - ageH * H) / 1000, subreddit: sub, author: 'someone' });
const listing = posts => Response.json({ data: { children: posts.map(d => ({ kind: 't3', data: d })) } });
function api(handler) { const calls = []; return { calls, fn: async (url, init = {}) => { calls.push({ url: new URL(url), init }); return handler(new URL(url), init, calls.length); } }; }
async function setup(subs = ['bangalorerentals'], sched = {}) {
  const t = await memoryDb(); await t.repo.createArea(GREEN_GLEN, Date.now());
  await t.repo.putSettings({ subreddits: subs.map(name => ({ name })), schedule: { ...SCHEDULE_DEFAULTS, redditPublic: true, ...sched } });
  return t;
}
const step = async (t, a, opts = {}) => redditPublicStep(t.repo, ENV, { fetchFn: a.fn, settings: await t.repo.getSettings(), sch: { ...SCHEDULE_DEFAULTS }, sleep: async () => {}, ...opts });

test('public JSON: new.json URL, honest headers, posts ingested, status recorded', async () => {
  const t = await setup();
  const a = api(() => listing([rpost(1, 'bangalorerentals', 1), rpost(2, 'bangalorerentals', 5)]));
  const r = await step(t, a);
  assert.equal(r.action, 'done'); assert.equal(r.fetched, 2);
  assert.equal(a.calls.length, 1);
  const c = a.calls[0];
  assert.equal(c.url.origin + c.url.pathname, 'https://old.reddit.com/r/bangalorerentals/new.json');
  assert.equal(c.url.searchParams.get('limit'), '50'); assert.equal(c.url.searchParams.get('raw_json'), '1');
  assert.equal(c.init.headers['user-agent'], PUBLIC_UA); assert.equal(c.init.headers.accept, 'application/json');
  assert.equal(c.init.headers.authorization, undefined); assert.equal(c.init.headers.cookie, undefined);
  const s = await t.repo.getSettings();
  assert.equal(s.redditStatus.ok, true); assert.equal(s.redditStatus.mode, 'public'); assert.equal(s.redditStatus.consecutiveFails, 0); assert.equal(s.redditStatus.postsRead, 2);
  const l = (await t.repo.listListings()).find(x => x.groups.includes('r/bangalorerentals'));
  assert.match(l.posts[0].url, /^https:\/\/www\.reddit\.com\/r\/bangalorerentals\/comments\//);
});

test('public JSON: cron uses it only when switched on and no OAuth secrets; OAuth path unchanged with secrets', async () => {
  resetRedditToken();
  const t = await setup(['bangalorerentals'], {});
  const posts = [rpost(1, 'bangalorerentals', 1)];
  const a = api(u => u.hostname === 'old.reddit.com' ? listing(posts) : u.hostname === 'oauth.reddit.com' ? listing(posts) : new Response('x', { status: 404 }));
  const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: a.fn });
  assert.equal((await app.scheduled({}, ENV)).reddit.action, 'done');
  assert.ok(a.calls.every(c => c.url.hostname === 'old.reddit.com'));
  // off by default: redditEnabled not explicitly true -> no calls
  const t2 = await memoryDb(); await t2.repo.putSettings({ subreddits: [{ name: 'bangalorerentals' }], schedule: { ...SCHEDULE_DEFAULTS, redditEnabled: true } });
  const a2 = api(() => listing([]));
  assert.equal((await createApp({ repo: () => t2.repo, assets: async () => null, fetch: a2.fn }).scheduled({}, ENV)).reddit, undefined); assert.equal(a2.calls.length, 0);
  // with OAuth secrets the API path is used, not public JSON
  const t3 = await setup(); resetRedditToken();
  const a3 = api(u => u.href === REDDIT_TOKEN_URL ? Response.json({ access_token: 'tk', expires_in: 3600 }) : listing(posts));
  await createApp({ repo: () => t3.repo, assets: async () => null, fetch: a3.fn }).scheduled({}, { ...ENV, REDDIT_CLIENT_ID: 'c', REDDIT_CLIENT_SECRET: 's' });
  assert.ok(a3.calls.some(c => c.url.hostname === 'oauth.reddit.com')); assert.ok(!a3.calls.some(c => c.url.hostname === 'old.reddit.com'));
});

test('public JSON: cursor advances only after ingest and only newer posts are read next time', async () => {
  const t = await setup();
  const posts = [rpost(1, 'bangalorerentals', 3)];
  const a = api(() => listing(posts));
  await step(t, a);
  const w1 = (await t.repo.getSettings()).reddit.watermarks.bangalorerentals;
  assert.ok(w1 > 0);
  posts.unshift(rpost(2, 'bangalorerentals', 0.5));
  const r = await step(t, a, { force: true });
  assert.equal(r.fetched, 1);
  assert.ok((await t.repo.getSettings()).reddit.watermarks.bangalorerentals > w1);
  // an ingest failure leaves the cursor where it was
  const t2 = await setup(); const a2 = api(() => listing([rpost(1, 'bangalorerentals', 1)]));
  const bad = { ...t2.repo, saveIngest: async () => { throw new Error('d1 down'); } };
  const s2 = await t2.repo.getSettings();
  await assert.rejects(() => redditPublicStep(bad, ENV, { fetchFn: a2.fn, settings: s2, sch: { ...SCHEDULE_DEFAULTS }, sleep: async () => {} }));
  assert.equal((await t2.repo.getSettings()).reddit?.watermarks?.bangalorerentals, undefined);
});

for (const [name, mk] of [['403', () => new Response('blocked', { status: 403 })], ['429', () => new Response('slow', { status: 429 })], ['500', () => new Response('x', { status: 503 })], ['HTML', () => new Response('<html>Please wait</html>', { status: 200, headers: { 'content-type': 'text/html' } })]]) {
  test(`public JSON: ${name} stops Reddit for the run, records status, never retries; backoff after 3 fails`, async () => {
    const t = await setup(['a_sub', 'b_sub', 'c_sub']);
    const a = api(() => mk());
    let now = Date.now();
    for (let i = 1; i <= 3; i++) {
      const r = await step(t, a, { now, force: true });
      assert.equal(r.action, 'blocked');
      const st = (await t.repo.getSettings()).redditStatus;
      assert.equal(st.ok, false); assert.equal(st.consecutiveFails, i); assert.equal(st.at, now);
      if (name !== 'HTML') assert.equal(st.code, Number(name === '500' ? 503 : name));
      assert.equal(a.calls.length, i, 'one request per run, no retry, other subreddits skipped');
      now += H;
    }
    assert.ok((await t.repo.getSettings()).redditStatus.backoffUntil > now);
    const skipped = await step(t, a, { now, force: true });
    assert.equal(skipped.action, 'backoff'); assert.equal(a.calls.length, 3);
    const later = await step(t, api(() => listing([])), { now: now + 6 * H + 1, force: true });
    assert.equal(later.action, 'done');
    assert.equal((await t.repo.getSettings()).redditStatus.consecutiveFails, 0);
  });
}

test('public JSON: throttled, capped per run, and within the D1 budget', async () => {
  const t = await setup(['s1', 's2', 's3', 's4', 's5']);
  let n = 0;
  const c = { ...t.db, all: (...x) => (n++, t.db.all(...x)), first: (...x) => (n++, t.db.first(...x)), run: (...x) => (n++, t.db.run(...x)), batch: l => (n += l.length, t.db.batch(l)) };
  const repo = createRepo(c);
  const a = api(u => listing(Array.from({ length: 30 }, (_, i) => rpost(i + 1, u.pathname.split('/')[2], 1 + i / 100))));
  const sleeps = [];
  const r = await redditPublicStep(repo, ENV, { fetchFn: a.fn, settings: await repo.getSettings(), sch: { ...SCHEDULE_DEFAULTS }, budget: 42, sleep: async ms => sleeps.push(ms) });
  assert.equal(r.action, 'continuing'); assert.ok(a.calls.length <= 3 && a.calls.length >= 1);
  assert.equal(sleeps.length, a.calls.length - 1); assert.ok(sleeps.every(ms => ms >= 2000));
  assert.ok(n <= 48, 'D1 statements ' + n);
  assert.ok((await repo.getSettings()).reddit.cycle.queue.length > 0, 'the rest resumes next invocation');
});
