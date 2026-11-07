// Apify integration (docs/APIFY.md): our cron starts runs itself, Apify calls our webhook when a run
// succeeds, and the cron also sweeps recent succeeded runs in case a webhook was missed.
// Dataset reads are paged; progress is saved per page so a cut-off invocation resumes later.

import { ingestItems } from './ingest.js';
import { createRepo } from './db/repo.js';
import { isPage } from './groups.js';
import { runBackfill } from './backfill.js';
import { redditStep, redditConfigured } from './reddit.js';
import { runEnrich, aiConfigured } from './ai.js';

export const API = 'https://api.apify.com/v2';
export const DEFAULT_ACTOR = 'automly~facebook-public-group-posts-scraper';
export const OFFICIAL_ACTOR = 'apify~facebook-groups-scraper';
export const DEFAULT_RESULTS_PER_GROUP = 25;
const HOUR = 36e5;
const DAY = 24 * HOUR;
// Admin-controlled schedule (settings.schedule). The Worker cron fires hourly; a run starts only when due.
export const SCHEDULE_DEFAULTS = { enabled: true, intervalHours: 4, budgetWarnPct: 80, budgetStopPct: 95, retentionDays: 30, backfillDays: 3, redditEnabled: true };
export const scheduleOf = settings => ({ ...SCHEDULE_DEFAULTS, ...(settings?.schedule && typeof settings.schedule === 'object' ? settings.schedule : {}) });
/** When the next Apify run is due (ms), or null when scheduling is off. */
export function nextRunAt(settings) {
  const sch = scheduleOf(settings); if (!sch.enabled) return null;
  const last = settings?.scheduler?.lastStartedAt;
  return last ? last + sch.intervalHours * HOUR : Date.now();
}
/** Never ask a source for more than the last backfillDays: cutoff = max(last good start - 1 h, now - backfillDays). */
export function cutoffFor(lastGoodStart, sch, now) {
  const floor = now - Math.min(5, Math.max(1, sch.backfillDays || 3)) * DAY;
  return Math.max(lastGoodStart ? lastGoodStart - HOUR : floor, floor);
}
/** Wrap a repository so every D1 statement counts against a per-invocation budget (Workers Free: 50). */
export function budgeted(repo, cap = 48) {
  let n = 0; const d = repo.db;
  const c = { ...d, all: (...a) => (n++, d.all(...a)), first: (...a) => (n++, d.first(...a)), run: (...a) => (n++, d.run(...a)), batch: l => (n += l.length, d.batch(l)) };
  const r = createRepo(c); r.used = () => n; r.left = () => cap - n;
  return r;
}
// Pages per invocation. Workers Free allows 50 D1 queries per invocation; ingest setup is ~5 and each
// page ~9 (key lookup, candidates, token lists, merge load, one 5-statement write batch), so 4 pages
// stay under the cap. A longer dataset is saved as 'partial' and continued by Apify's webhook retry
// or the next sweep.
export const MAX_PAGES = 4;
const SWEEP_PAGES = 3; // the cron also starts a run in the same invocation

export const actorId = env => {
  const a = String(env.APIFY_ACTOR || DEFAULT_ACTOR).trim().replace('/', '~');
  if (!/^[A-Za-z0-9._-]+~[A-Za-z0-9._-]+$/.test(a)) throw new Error('APIFY_ACTOR must look like "user~actor-name"');
  return a;
};
export const isDatasetId = id => typeof id === 'string' && /^[A-Za-z0-9]{6,40}$/.test(id);
// Small pages so that one page always fits in the Workers Free 10 ms CPU budget (v2 stores every
// housing post, so each post is fuzzy-matched: 25 posts measured ~10 ms JS vs 3,000 listings, 15 ~4.5 ms): an invocation
// cut off mid-way still saved every finished page, so each retry makes progress.
export const pageSize = env => Math.min(500, Math.max(10, parseInt(env.INGEST_PAGE_SIZE, 10) || 15));

// No `fields=`: the actors' real column names are unverified (docs/APIFY.md), and a name missing
// from a whitelist would silently drop data. Omit only comment columns, which can be large and
// which normalizeRaw/collectImages ignore anyway (collectImages skips keys matching /comments?/).
export const DATASET_OMIT = ['topComments', 'latestComments', 'comments'];

async function apify(env, path, init = {}, fetchFn = fetch) {
  if (!env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set');
  const r = await fetchFn(API + path, { ...init, headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) {
    // Apify explains 4xx errors in the body ({error:{type,message}}); surface it so admins can act on it.
    let why = '';
    try { const b = await r.json(); why = [b?.error?.type, b?.error?.message].filter(Boolean).join(': ').replace(/apify_api_\w+/g, '[token]').slice(0, 300); } catch {}
    throw new Error(`Apify ${init.method || 'GET'} ${path.split('?')[0]} -> HTTP ${r.status}${why ? ` (${why})` : ''}`);
  }
  return r.json();
}

/** Input for the configured actor. Each actor names things differently. */
export function buildInput(actor, { groups, resultsPerGroup, after }) {
  const urls = groups.map(g => g.url);
  const iso = new Date(after).toISOString();
  if (actor === OFFICIAL_ACTOR) return { startUrls: urls.map(url => ({ url })), resultsLimit: resultsPerGroup, viewOption: 'CHRONOLOGICAL', onlyPostsNewerThan: iso };
  // The automly actor documents postsPublishedAfter as a date ("2026-09-01", UTC). Send the date only;
  // the extra hours it may return are dropped for free by post_keys dedupe.
  return { groups: urls, resultsPerGroup, sortOrder: 'new', postsPublishedAfter: iso.slice(0, 10), includeGroupInfo: true };
}
/** Per-run webhook (base64 JSON) so Apify calls /api/ingest/apify when the run succeeds. */
export function webhookParam(env) {
  if (!env.PUBLIC_BASE_URL || !env.INGEST_SECRET) return null;
  const def = [{
    eventTypes: ['ACTOR.RUN.SUCCEEDED'],
    requestUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/ingest/apify',
    headersTemplate: JSON.stringify({ 'X-Ingest-Secret': env.INGEST_SECRET }),
    payloadTemplate: '{"datasetId":{{resource.defaultDatasetId}},"runId":{{resource.id}}}',
  }];
  return btoa(JSON.stringify(def));
}

/** Monthly usage vs limit, from GET /v2/users/me/limits. */
export async function getUsage(env, fetchFn = fetch) {
  const { data } = await apify(env, '/users/me/limits', {}, fetchFn);
  const used = Number(data?.current?.monthlyUsageUsd ?? 0), limit = Number(data?.limits?.maxMonthlyUsageUsd ?? 5);
  return { usedUsd: Math.round(used * 100) / 100, limitUsd: limit, ratio: limit > 0 ? used / limit : 1, cycleEnd: data?.monthlyUsageCycle?.endAt || null };
}

/**
 * Ingest one dataset, page by page. Returns {status:'skipped'|'done', report}.
 * The runs row is the lock: claimRun fails when the dataset was already ingested or is being ingested.
 */
export async function ingestDataset(repo, env, { datasetId, runId, startedAt, costUsd }, { fetchFn = fetch, now = Date.now(), maxPages = MAX_PAGES } = {}) {
  if (!isDatasetId(datasetId)) throw new Error('bad dataset id');
  if (!(await repo.claimRun({ datasetId, runId, startedAt, now }))) {
    const cur = await repo.getRunByDataset(datasetId);
    return { status: 'skipped', reason: cur?.status === 'done' ? 'already ingested' : 'in progress' };
  }
  const prev = await repo.getRunByDataset(datasetId);
  let report = prev?.report?.progress ? prev.report : null; // resume after a cut-off invocation
  if (report) delete report.error;
  let offset = report?.progress?.offset || 0;
  let groups = report?.progress?.groups || [];
  const [areas, settings] = await Promise.all([repo.listAreas(), repo.getSettings()]);
  const limit = pageSize(env);
  const mergeGroups = more => [...new Map([...groups, ...more].map(g => [g.id, g])).values()].slice(0, 200);
  let partial = false;
  try {
    for (let page = 0; ; page++) {
      const q = `?clean=true&format=json&limit=${limit}&offset=${offset}&omit=${DATASET_OMIT.join(',')}`;
      const items = await apify(env, `/datasets/${datasetId}/items${q}`, {}, fetchFn);
      if (!Array.isArray(items)) throw new Error('dataset items is not an array');
      const last = items.length < limit;
      partial = !last && page === maxPages - 1; // page budget used up: save progress, resume later
      const nextOffset = offset + items.length;
      // Progress is saved in the same batch as this page's listings; it must include the group rows
      // found on this page, so it is built after the page's rows are parsed.
      const progress = last ? null : pageGroups => ({ offset: nextOffset, groups: mergeGroups(pageGroups) });
      const res = await ingestItems(repo, items, { source: 'apify', now, datasetId, areas, settings, groups, storeAll: true, env, run: { status: last ? 'done' : partial ? 'partial' : 'ingesting', report, progress } });
      report = res.runReport;
      groups = mergeGroups(res.groups);
      offset = nextOffset;
      if (last || partial) break;
    }
  } catch (e) {
    // Keep the progress already saved; mark failed so the sweep (or Apify's retry) can resume.
    await repo.failRunKeepProgress(datasetId, String(e.message || e), now);
    throw e;
  }
  if (partial) return { status: 'partial', report };
  delete report.progress;
  if (typeof costUsd === 'number' && isFinite(costUsd)) await repo.setRunCost(datasetId, Math.round(costUsd * 10000) / 10000);
  if (report.unscrapable?.length) await repo.putSettings({ unscrapableGroups: { at: now, datasetId, groups: report.unscrapable.slice(0, 50) } });
  else await repo.putSettings({ unscrapableGroups: { at: now, datasetId, groups: [] } });
  return { status: 'done', report };
}

/**
 * Ingest recent succeeded runs whose dataset we have not ingested yet (missed webhooks, resumes).
 * At most one dataset per call, to stay inside the per-invocation D1 query cap; older first.
 */
export async function sweep(repo, env, { fetchFn = fetch, now = Date.now() } = {}) {
  const actor = actorId(env);
  const { data } = await apify(env, `/acts/${actor}/runs?status=SUCCEEDED&desc=1&limit=3`, {}, fetchFn);
  const runs = (data?.items || []).filter(r => isDatasetId(r.defaultDatasetId));
  const statuses = await repo.runStatuses(runs.map(r => r.defaultDatasetId));
  const out = [];
  for (const r of runs.reverse()) {
    const st = statuses.get(r.defaultDatasetId);
    if (st === 'done') continue;
    const res = await ingestDataset(repo, env, { datasetId: r.defaultDatasetId, runId: r.id, startedAt: Date.parse(r.startedAt) || null, costUsd: typeof r.usageTotalUsd === 'number' ? r.usageTotalUsd : undefined }, { fetchFn, now, maxPages: SWEEP_PAGES });
    out.push({ datasetId: r.defaultDatasetId, status: res.status, newListings: res.report?.newListings ?? 0 });
    if (res.status !== 'skipped') break;
  }
  return out;
}

/** Budget check, then start a run for the active watched groups. Facebook Pages are skipped (the group actor can't read them). */
export async function startRun(repo, env, { fetchFn = fetch, now = Date.now(), settings = null } = {}) {
  settings = settings || await repo.getSettings();
  const sch = scheduleOf(settings);
  const all = (Array.isArray(settings.groups) ? settings.groups : []).filter(g => g.active !== false && g.url);
  const pages = all.filter(isPage); const groups = all.filter(g => !isPage(g));
  const pageNote = pages.length ? `Skipped ${pages.length} Facebook Page${pages.length > 1 ? 's' : ''} (the group scraper can't read Pages). ` : '';
  if (!groups.length) return { action: 'skipped', detail: (pageNote + 'No active watched groups with a link. Add them in Settings.').trim() };
  let perGroup = Number(settings.resultsPerGroup) || DEFAULT_RESULTS_PER_GROUP;
  let usage = null, detail = pageNote;
  try {
    usage = await getUsage(env, fetchFn);
    await repo.putSettings({ apifyUsage: { ...usage, checkedAt: now } });
  } catch (e) { detail += 'Could not read Apify usage (' + e.message + '); started anyway. '; }
  if (usage && usage.ratio > sch.budgetStopPct / 100) return { action: 'skipped', detail: `Apify credit ${Math.round(usage.ratio * 100)}% used ($${usage.usedUsd} of $${usage.limitUsd}). Runs resume when the monthly cycle resets.` };
  if (usage && usage.ratio > sch.budgetWarnPct / 100) { perGroup = Math.max(5, Math.floor(perGroup / 2)); detail += `Credit ${Math.round(usage.ratio * 100)}% used, so ${perGroup} posts per group. `; }
  const after = cutoffFor(await repo.lastSuccessfulStart(), sch, now);
  const actor = actorId(env);
  const input = buildInput(actor, { groups, resultsPerGroup: perGroup, after });
  const hook = webhookParam(env);
  const { data } = await apify(env, `/acts/${actor}/runs${hook ? `?webhooks=${encodeURIComponent(hook)}` : ''}`, { method: 'POST', body: JSON.stringify(input) }, fetchFn);
  if (data?.id && isDatasetId(data.defaultDatasetId)) await repo.recordStartedRun({ runId: data.id, datasetId: data.defaultDatasetId, startedAt: Date.parse(data.startedAt) || now, actor });
  if (!hook) detail += 'PUBLIC_BASE_URL or INGEST_SECRET is not set, so results arrive with the next sweep instead of a webhook. ';
  return { action: 'started', runId: data?.id, groups: groups.length, skippedPages: pages.length, resultsPerGroup: perGroup, after, detail: detail.trim() };
}

/**
 * The hourly cron job, inside one invocation's D1 query budget:
 *   1. Apify: start a run when due (or forced), then sweep one unfinished dataset. Starting first means a
 *      sweep that fails (or is cut off by the CPU limit) can never stop new runs from starting.
 *   2. Reddit: one step of the direct Reddit source when due or mid-cycle (src/reddit.js).
 *   3. Area backfill chunks, then the daily retention purge, with whatever budget is left.
 */
export async function scheduledJob(baseRepo, env, { fetchFn = fetch, now = Date.now(), force = false } = {}) {
  const repo = baseRepo.left ? baseRepo : budgeted(baseRepo);
  const settings = await repo.getSettings();
  const sch = scheduleOf(settings);
  const prev = settings.scheduler || {};
  const status = { at: now, swept: [], action: '', detail: '', lastStartedAt: prev.lastStartedAt || null };
  if (!env.APIFY_TOKEN) { status.action = 'skipped'; status.detail = 'APIFY_TOKEN is not set.'; }
  else {
    const due = force || (sch.enabled && (!prev.lastStartedAt || now - prev.lastStartedAt >= sch.intervalHours * HOUR - 5 * 60e3));
    if (due) {
      try { const r = await startRun(repo, env, { fetchFn, now, settings }); status.action = r.action; status.detail = r.detail ? r.detail + ' ' : ''; status.runId = r.runId; if (r.action === 'started') status.lastStartedAt = now; }
      catch (e) { status.action = 'error'; status.detail = 'Start failed: ' + e.message + '. '; }
      await repo.putSettings({ scheduler: { ...status, detail: status.detail.trim() } });
    } else status.action = sch.enabled ? 'not_due' : 'paused';
    try { status.swept = await sweep(repo, env, { fetchFn, now }); } catch (e) { status.detail += 'Sweep failed: ' + e.message + '.'; }
  }
  if (!force) await extras(repo, env, settings, sch, status, { fetchFn, now });
  status.detail = status.detail.trim();
  status.nextRunAt = sch.enabled ? (status.lastStartedAt ? status.lastStartedAt + sch.intervalHours * HOUR : now + HOUR) : null;
  await repo.putSettings({ scheduler: status });
  if (!env.APIFY_TOKEN && status.action === 'skipped' && !status.reddit && !status.backfill && !status.purged) return { action: 'skipped', detail: status.detail, swept: [] };
  return status;
}

async function extras(repo, env, settings, sch, status, { fetchFn, now }) {
  if (redditConfigured(env) && sch.redditEnabled !== false && repo.left() >= 26) {
    try { status.reddit = await redditStep(repo, env, { fetchFn, now, settings, sch, budget: repo.left() - 6 }); }
    catch (e) { status.reddit = { error: String(e.message || e).slice(0, 200) }; }
  }
  if (aiConfigured(env) && repo.left() >= 20) {
    try { status.ai = await runEnrich(repo, env, { maxCalls: 6, now, fetchFn }); } catch (e) { status.detail += ' AI failed: ' + e.message + '.'; }
  }
  if (settings.areaBackfill && Object.keys(settings.areaBackfill).length && repo.left() >= 12) {
    try { status.backfill = await runBackfill(repo, { maxQueries: repo.left() - 4, now }); } catch (e) { status.detail += ' Backfill failed: ' + e.message + '.'; }
  }
  const lastPurge = settings.purge?.at || 0;
  if (now - lastPurge >= DAY - HOUR && repo.left() >= 10) {
    try {
      const n = await repo.purgeOld(now - Math.max(1, sch.retentionDays) * DAY, now);
      await repo.putSettings({ purge: { at: now, deleted: n, retentionDays: sch.retentionDays } });
      status.purged = n;
    } catch (e) { status.detail += ' Purge failed: ' + e.message + '.'; }
  }
}
