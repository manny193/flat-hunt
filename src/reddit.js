// Reddit as a second source, straight from Reddit's official API (no Apify credit used).
// Auth: OAuth2 application-only, grant_type=client_credentials, HTTP Basic with REDDIT_CLIENT_ID /
// REDDIT_CLIENT_SECRET, a descriptive User-Agent ("flat-hunt/1.0 by <REDDIT_USERNAME>"). Data calls go to
// https://oauth.reddit.com with the bearer token. Free tier: 100 requests/minute; we use a handful per run.
//
// A "cycle" starts every intervalHours (same schedule setting as Apify, independent of it). Each cron
// invocation fetches /new (or a search) for one subreddit at a time, ingests the posts newer than the
// cutoff and the subreddit's watermark, oldest first, in pages that fit the D1 query budget, and moves
// the watermark forward. A cycle may span several hourly invocations on the first run.

import { ingestItems } from './ingest.js';

export const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
export const REDDIT_API = 'https://oauth.reddit.com';
export const DEFAULT_SUBREDDITS = [
  { name: 'bangalorerentals', active: true },
  { name: 'BangaloreFlatsRental', active: true },
  { name: 'BangloreClassifieds', active: true },
  { name: 'Real_Estate_Bangalore', active: true },
  { name: 'bangalore', query: 'flat OR flatmate OR rent OR bhk', active: true },
];
const HOUR = 36e5, DAY = 24 * HOUR;
const PAGE = 25;              // posts per ingest call (same CPU budget as Apify pages)
const QUERIES_PER_PAGE = 10;  // ingest page (~9) + slack

export const redditConfigured = env => !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);
export const userAgent = env => `flat-hunt/1.0 by ${String(env.REDDIT_USERNAME || 'flat-hunt').replace(/[^\w-]/g, '').slice(0, 40) || 'flat-hunt'}`;
export const subredditsOf = settings => (Array.isArray(settings?.subreddits) ? settings.subreddits : DEFAULT_SUBREDDITS).filter(s => s && s.active !== false && /^[A-Za-z0-9_]{2,40}$/.test(s.name));

/** Validate an admin-supplied subreddit list. */
export function validateSubreddits(list) {
  if (!Array.isArray(list) || list.length > 30) return null;
  const out = [];
  for (const s of list) {
    const name = String(s?.name || '').replace(/^\/?r\//i, '').trim();
    if (!/^[A-Za-z0-9_]{2,40}$/.test(name)) return null;
    const q = typeof s?.query === 'string' ? s.query.trim().slice(0, 200) : '';
    out.push({ name, ...(q ? { query: q } : {}), active: s?.active !== false });
  }
  return out;
}

const tok = { value: '', exp: 0 };
export function resetRedditToken() { tok.value = ''; tok.exp = 0; }
async function token(env, fetchFn, now) {
  if (tok.value && tok.exp - 60e3 > now) return tok.value;
  const r = await fetchFn(REDDIT_TOKEN_URL, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { authorization: 'Basic ' + btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent(env) },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('Reddit token request failed: HTTP ' + r.status);
  const j = await r.json();
  if (!j.access_token) throw new Error('Reddit token response had no access_token');
  tok.value = j.access_token; tok.exp = now + (Number(j.expires_in) || 3600) * 1000;
  return tok.value;
}

export function listingPath(sub) {
  const base = `/r/${sub.name}`;
  return sub.query
    ? `${base}/search?q=${encodeURIComponent(sub.query)}&restrict_sr=1&sort=new&t=week&limit=100&raw_json=1`
    : `${base}/new?limit=100&raw_json=1`;
}

/** Reddit "t3" post -> the raw item shape ingest understands. */
export function toItem(d) {
  const images = [];
  for (const im of d?.preview?.images || []) if (im?.source?.url) images.push(im.source.url);
  if (/^https:\/\/i\.redd\.it\//.test(d?.url || '')) images.push(d.url);
  return {
    text: [d.title, d.selftext].filter(Boolean).join('\n\n'),
    url: d.permalink ? 'https://www.reddit.com' + d.permalink : '',
    createdAt: new Date((Number(d.created_utc) || 0) * 1000).toISOString(),
    groupName: 'r/' + d.subreddit,
    groupUrl: 'https://www.reddit.com/r/' + d.subreddit,
    author: d.author && d.author !== '[deleted]' ? 'u/' + d.author : '',
    images: images.slice(0, 6),
  };
}

/**
 * One cron step. Returns a small status object; persists progress in settings.reddit and the run row
 * (runs.source = 'reddit', dataset_id = 'reddit-<startMs>') so the admin charts cover Reddit too.
 */
export async function redditStep(repo, env, { fetchFn = fetch, now = Date.now(), settings, sch, budget = 30, force = false }) {
  const state = { ...(settings.reddit || {}) };
  const subs = subredditsOf(settings);
  let cycle = state.cycle;
  if (!cycle) {
    const due = force || !state.lastStartedAt || now - state.lastStartedAt >= sch.intervalHours * HOUR - 5 * 60e3;
    if (!due || !subs.length) return { action: subs.length ? 'not_due' : 'no_subreddits' };
    const floor = now - Math.min(5, Math.max(1, sch.backfillDays || 3)) * DAY;
    const cutoff = Math.max(state.lastGoodStart ? state.lastGoodStart - HOUR : floor, floor);
    cycle = { key: 'reddit-' + now, startedAt: now, cutoff, queue: subs.map(s => s.name), fetched: 0, errors: [] };
    await repo.createRun({ source: 'reddit', datasetId: cycle.key, startedAt: now, actor: 'reddit-api' });
    state.lastStartedAt = now;
  }
  const marks = { ...(state.watermarks || {}) };
  const watched = [...(Array.isArray(settings.groups) ? settings.groups : []), ...subs.map(s => ({ name: 'r/' + s.name, url: 'https://www.reddit.com/r/' + s.name, active: true }))];
  const ingestSettings = { ...settings, groups: watched };
  const areas = await repo.listAreas();
  let report = (await repo.getRunByDataset(cycle.key))?.report || null;
  let left = budget - 3;
  let bearer = null;
  while (cycle.queue.length && left >= QUERIES_PER_PAGE + 2) {
    const name = cycle.queue[0];
    const sub = subs.find(s => s.name === name) || { name };
    let posts;
    try {
      bearer = bearer || await token(env, fetchFn, now);
      const r = await fetchFn(REDDIT_API + listingPath(sub), { headers: { authorization: 'Bearer ' + bearer, 'user-agent': userAgent(env) }, signal: AbortSignal.timeout(10000) });
      if (r.status === 401) resetRedditToken();
      if (!r.ok) throw new Error(`r/${name}: HTTP ${r.status}`);
      const j = await r.json();
      posts = (j?.data?.children || []).map(c => c?.data).filter(d => d && d.id && !d.stickied);
    } catch (e) {
      cycle.errors = [...(cycle.errors || []), String(e.message || e).slice(0, 160)].slice(-10);
      cycle.queue.shift(); continue;
    }
    const since = Math.max(cycle.cutoff, marks[name] || 0);
    const fresh = posts.map(d => ({ d, t: (Number(d.created_utc) || 0) * 1000 })).filter(x => x.t > since).sort((a, b) => a.t - b.t);
    cycle.fetched += fresh.length;
    while (fresh.length && left >= QUERIES_PER_PAGE + 2) {
      const page = fresh.splice(0, PAGE);
      const res = await ingestItems(repo, page.map(x => toItem(x.d)), { source: 'reddit', now, datasetId: cycle.key, areas, settings: ingestSettings, storeAll: true, env, run: { status: 'ingesting', report } });
      report = res.runReport;
      marks[name] = page[page.length - 1].t;
      left -= QUERIES_PER_PAGE;
    }
    if (!fresh.length) cycle.queue.shift();
  }
  state.watermarks = marks;
  let done = false;
  if (!cycle.queue.length) {
    done = true;
    await repo.finishRun(cycle.key, { status: cycle.errors?.length && !cycle.fetched ? 'failed' : 'done', report: { ...(report || {}), source: 'reddit', fetched: cycle.fetched, errors: cycle.errors || [] }, now });
    state.lastRun = { at: now, startedAt: cycle.startedAt, fetched: cycle.fetched, newListings: report?.newListings || 0, errors: cycle.errors || [] };
    if (!(cycle.errors || []).length || cycle.fetched) state.lastGoodStart = cycle.startedAt;
    delete state.cycle;
  } else state.cycle = cycle;
  await repo.putSettings({ reddit: state });
  return { action: done ? 'done' : 'continuing', fetched: cycle.fetched, queue: cycle.queue.length, errors: (cycle.errors || []).length };
}

// ---------- Public JSON mode (no API key) ----------
// Used when the OAuth secrets are absent and the admin turned on schedule.redditPublic (off by default; redditEnabled stays the master switch).
// One GET per watched subreddit per run to old.reddit.com/r/<name>/new.json, honest User-Agent, no cookies,
// no proxies. Any block (403/429/5xx/HTML) stops Reddit for the run and is never retried around.
export const PUBLIC_UA = 'FlatHunt/1.0 (+https://flat-hunt.19mnsh.workers.dev)';
const PUBLIC_MAX_SUBS = 3;        // requests per cron invocation (each ingest page costs ~10 D1 statements)
const PUBLIC_GAP_MS = 2000;       // pause between requests (waiting is not CPU)
const BACKOFF_FAILS = 3, BACKOFF_MS = 6 * HOUR;
export const publicListingUrl = name => `https://old.reddit.com/r/${name}/new.json?limit=50&raw_json=1`;
/** Which mode would run now: 'api' (OAuth secrets set), 'public' (switched on explicitly) or null. */
export const redditMode = (env, settings) => redditConfigured(env) ? 'api' : (settings?.schedule?.redditPublic === true && settings.schedule.redditEnabled !== false ? 'public' : null);

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const queryTest = q => { const words = String(q || '').split(/\s+/).filter(w => w && !/^or$/i.test(w)).map(w => w.toLowerCase()); return words.length ? d => { const t = ((d.title || '') + ' ' + (d.selftext || '')).toLowerCase(); return words.some(w => t.includes(w)); } : () => true; };

export async function redditPublicStep(repo, env, { fetchFn = fetch, now = Date.now(), settings, sch, budget = 30, force = false, sleep = sleepMs }) {
  const status = { ...(settings.redditStatus || {}), mode: 'public' };
  if (status.backoffUntil && now < status.backoffUntil) return { action: 'backoff', until: status.backoffUntil };
  const state = { ...(settings.reddit || {}) };
  const subs = subredditsOf(settings);
  let cycle = state.cycle;
  if (!cycle) {
    const due = force || !state.lastStartedAt || now - state.lastStartedAt >= sch.intervalHours * HOUR - 5 * 60e3;
    if (!due || !subs.length) return { action: subs.length ? 'not_due' : 'no_subreddits' };
    const floor = now - Math.min(5, Math.max(1, sch.backfillDays || 3)) * DAY;
    const cutoff = Math.max(state.lastGoodStart ? state.lastGoodStart - HOUR : floor, floor);
    cycle = { key: 'reddit-' + now, startedAt: now, cutoff, queue: subs.map(s => s.name), fetched: 0, errors: [] };
    await repo.createRun({ source: 'reddit', datasetId: cycle.key, startedAt: now, actor: 'reddit-public-json' });
    state.lastStartedAt = now;
  }
  const marks = { ...(state.watermarks || {}) };
  const watched = [...(Array.isArray(settings.groups) ? settings.groups : []), ...subs.map(s => ({ name: 'r/' + s.name, url: 'https://www.reddit.com/r/' + s.name, active: true }))];
  const ingestSettings = { ...settings, groups: watched };
  const areas = await repo.listAreas();
  let report = (await repo.getRunByDataset(cycle.key))?.report || null;
  let left = budget - 3, requests = 0, blocked = null;
  while (cycle.queue.length && left >= QUERIES_PER_PAGE * 2 + 2 && requests < PUBLIC_MAX_SUBS) {
    const name = cycle.queue[0];
    const sub = subs.find(s => s.name === name) || { name };
    if (requests) await sleep(PUBLIC_GAP_MS);
    requests++;
    let posts, code = 0;
    try {
      const r = await fetchFn(publicListingUrl(name), { headers: { 'user-agent': PUBLIC_UA, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      code = r.status;
      if (!r.ok) throw new Error(`r/${name}: HTTP ${r.status}`);
      let j; try { j = await r.json(); } catch { throw new Error(`r/${name}: response was not JSON`); }
      if (!Array.isArray(j?.data?.children)) throw new Error(`r/${name}: unexpected response`);
      posts = j.data.children.map(c => c?.data).filter(d => d && d.id && !d.stickied);
    } catch (e) {
      blocked = { code, error: String(e.message || e).slice(0, 160) };
      break; // never retry around a block
    }
    if (sub.query) posts = posts.filter(queryTest(sub.query));
    const since = Math.max(cycle.cutoff, marks[name] || 0);
    const fresh = posts.map(d => ({ d, t: (Number(d.created_utc) || 0) * 1000 })).filter(x => x.t > since).sort((a, b) => a.t - b.t);
    cycle.fetched += fresh.length;
    while (fresh.length) { // at most 50 posts = 2 pages
      const page = fresh.splice(0, PAGE);
      const res = await ingestItems(repo, page.map(x => toItem(x.d)), { source: 'reddit', now, datasetId: cycle.key, areas, settings: ingestSettings, storeAll: true, env, run: { status: 'ingesting', report } });
      report = res.runReport;
      marks[name] = page[page.length - 1].t; // cursor moves only after the page was ingested
      left -= QUERIES_PER_PAGE;
    }
    cycle.queue.shift();
  }
  state.watermarks = marks;
  let done = false;
  if (blocked) {
    cycle.errors = [...(cycle.errors || []), blocked.error];
    const fails = (status.consecutiveFails || 0) + 1;
    await repo.finishRun(cycle.key, { status: 'failed', report: { ...(report || {}), source: 'reddit', fetched: cycle.fetched, errors: cycle.errors }, now });
    state.lastRun = { at: now, startedAt: cycle.startedAt, fetched: cycle.fetched, newListings: report?.newListings || 0, errors: cycle.errors };
    delete state.cycle;
    Object.assign(status, { ok: false, code: blocked.code, error: blocked.error, at: now, consecutiveFails: fails, postsRead: cycle.fetched, ...(fails >= BACKOFF_FAILS ? { backoffUntil: now + BACKOFF_MS } : {}) });
  } else if (!cycle.queue.length) {
    done = true;
    await repo.finishRun(cycle.key, { status: 'done', report: { ...(report || {}), source: 'reddit', fetched: cycle.fetched, errors: [] }, now });
    state.lastRun = { at: now, startedAt: cycle.startedAt, fetched: cycle.fetched, newListings: report?.newListings || 0, errors: [] };
    state.lastGoodStart = cycle.startedAt;
    delete state.cycle;
    Object.assign(status, { ok: true, code: 200, error: null, at: now, lastSuccessAt: now, consecutiveFails: 0, backoffUntil: 0, postsRead: cycle.fetched });
  } else {
    state.cycle = cycle;
    Object.assign(status, { ok: true, code: 200, error: null, at: now, lastSuccessAt: now, consecutiveFails: 0, backoffUntil: 0 });
  }
  await repo.putSettings({ reddit: state, redditStatus: status });
  return { action: blocked ? 'blocked' : done ? 'done' : 'continuing', fetched: cycle.fetched, queue: blocked ? 0 : cycle.queue.length, errors: blocked ? 1 : 0, ...(blocked ? { code: blocked.code } : {}) };
}
