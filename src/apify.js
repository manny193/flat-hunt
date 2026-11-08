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
// With an exact cutoff, posts per group is only a safety cap: a run returns the posts since the last run.
export const DEFAULT_RESULTS_PER_GROUP = 30;
export const MAX_RESULTS_PER_GROUP = 50;
const HOUR = 36e5;
const DAY = 24 * HOUR;
const IST = 5.5 * HOUR;
// Overlap between runs: the cutoff is the last good start minus this, so posts a group admin approves a
// little late are not missed. Every post inside the overlap is paid for twice, so keep it short.
export const OVERLAP_MS = 15 * 60e3;
// Price per dataset row (USD) when the run does not say. automly: $1.20 / 1,000 rows (posts AND group
// rows); official actor on the free tier: $5 / 1,000 posts. Used for the per-run charge cap and group value.
export const ROW_PRICE = { 'automly~facebook-public-group-posts-scraper': 0.0012, 'apify~facebook-groups-scraper': 0.005 };
export const rowPrice = actor => ROW_PRICE[actor] ?? 0.005;
// Group details (name, privacy) cost one row per group, so they are fetched once a week or when the
// watched list changes, not on every run; posts are named from the stored details or our own settings.
export const GROUP_INFO_MAX_AGE = 7 * DAY;
// Admin-controlled schedule (settings.schedule). The Worker cron fires hourly at :00 IST.
//   mode 'times': run at these IST hours (default: every 2 h from 9 AM to 9 PM, when most people post,
//                 plus 6 AM to pick up the night's posts; the exact cutoff means no post is skipped).
//   mode 'interval': run every intervalHours.
export const DEFAULT_RUN_HOURS = [6, 9, 11, 13, 15, 17, 19, 21];
export const SCHEDULE_DEFAULTS = { enabled: true, mode: 'times', runHoursIst: DEFAULT_RUN_HOURS, intervalHours: 4, maxRunUsd: 0.5, budgetWarnPct: 80, budgetStopPct: 95, retentionDays: 30, backfillDays: 3, redditEnabled: true };
export const scheduleOf = settings => ({ ...SCHEDULE_DEFAULTS, ...(settings?.schedule && typeof settings.schedule === 'object' ? settings.schedule : {}) });
const runHours = sch => [...new Set((Array.isArray(sch.runHoursIst) ? sch.runHoursIst : []).filter(h => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
const useTimes = sch => sch.mode !== 'interval' && runHours(sch).length > 0;
/** Start (ms) of the IST clock hour that contains t. */
export const istHourStart = t => Math.floor((t + IST) / HOUR) * HOUR - IST;
export const istHour = t => new Date(t + IST).getUTCHours();
/**
 * Is a scheduled run due now? Never run before: yes. Times mode: the current IST hour is a run hour and
 * no run started in it yet. Interval mode: intervalHours since the last start (5 min early is fine).
 */
export function isDue(sch, lastStartedAt, now) {
  if (!sch.enabled) return false;
  if (!lastStartedAt) return true;
  if (useTimes(sch)) return runHours(sch).includes(istHour(now)) && !(lastStartedAt >= istHourStart(now));
  return !lastStartedAt || now - lastStartedAt >= sch.intervalHours * HOUR - 5 * 60e3;
}
/** When the next Apify run is due (ms), or null when scheduling is off. */
export function nextRunAt(settings, now = Date.now()) {
  const sch = scheduleOf(settings); if (!sch.enabled) return null;
  const last = settings?.scheduler?.lastStartedAt;
  if (useTimes(sch)) {
    const hours = runHours(sch);
    for (let i = 0; i <= 48; i++) { const t = istHourStart(now) + i * HOUR; if (hours.includes(istHour(t)) && !(last >= t)) return Math.max(t, i === 0 ? now : t); }
    return null;
  }
  return last ? last + sch.intervalHours * HOUR : now;
}
/** Never ask a source for more than the last backfillDays: cutoff = max(last good start - 15 min, now - backfillDays). */
export function cutoffFor(lastGoodStart, sch, now) {
  const floor = now - Math.min(5, Math.max(1, sch.backfillDays || 3)) * DAY;
  return Math.max(lastGoodStart ? lastGoodStart - OVERLAP_MS : floor, floor);
}
/** Cutoff as the actors accept it: "YYYY-MM-DDTHH:MM:SSZ". automly rejects milliseconds (HTTP 400). */
export const apifyTime = t => new Date(t).toISOString().slice(0, 19) + 'Z';
/** True when stored group details are missing, older than a week, or miss a watched group. */
export function groupInfoStale(settings, groups, now) {
  const info = settings?.groupInfo;
  if (!info?.at || now - info.at > GROUP_INFO_MAX_AGE) return true;
  const have = new Set((info.urls || []).map(u => String(u).toLowerCase()));
  return groups.some(g => !have.has(String(g.url).toLowerCase()));
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
export function buildInput(actor, { groups, resultsPerGroup, after, groupInfo = false }) {
  const urls = groups.map(g => g.url);
  const at = apifyTime(after);
  if (actor === OFFICIAL_ACTOR) return { startUrls: urls.map(url => ({ url })), resultsLimit: resultsPerGroup, viewOption: 'CHRONOLOGICAL', onlyPostsNewerThan: at };
  // automly's postsPublishedAfter accepts a full UTC time without milliseconds (its input pattern is
  // YYYY-MM-DD[THH:MM[:SS][Z]]). Posts before it are never returned, so they are never charged.
  return { groups: urls, resultsPerGroup, sortOrder: 'new', postsPublishedAfter: at, includeGroupInfo: !!groupInfo };
}
/**
 * Was a run cut short by its own limits? Then posts older than the ones it returned may be missing.
 * caps = {perGroup, maxItems, maxCharge, after, recover} as started. Returns null, or what was hit.
 */
export function truncation(report, caps, rowsRead, cost) {
  if (!caps) return null;
  const groups = Object.entries(report?.fetchedByGroup || {}).filter(([, n]) => n >= caps.perGroup).map(([g]) => g);
  const rows = caps.maxItems > 0 && rowsRead >= caps.maxItems;
  const charge = caps.maxCharge > 0 && (cost?.resultsUsd || 0) >= 0.95 * caps.maxCharge;
  if (!groups.length && !rows && !charge) return null;
  return { groups: groups.slice(0, 50), rows, charge, perGroup: caps.perGroup, after: caps.after ?? null, recover: !!caps.recover };
}
/**
 * What a finished run cost, from GET /v2/actor-runs/{id}: platform usage plus the actor's per-event charges.
 * Right after a run, Apify can still report 0 charged rows (measured 8 Nov), so rows are at least the
 * rows we read from the dataset (rowsRead).
 */
export function runCost(run, actor, rowsRead = 0) {
  if (!run || typeof run !== 'object') return null;
  const counts = run.chargedEventCounts && typeof run.chargedEventCounts === 'object' ? run.chargedEventCounts : {};
  const prices = run.pricingInfo?.pricingPerEvent?.actorChargeEvents || {};
  let eventsUsd = 0, rows = 0;
  for (const [ev, n] of Object.entries(counts)) {
    const num = Number(n) || 0;
    const p = prices[ev]?.eventPriceUsd ?? (ev === 'apify-default-dataset-item' || ev === 'post' ? rowPrice(actor) : 0);
    eventsUsd += num * p;
    if (ev === 'apify-default-dataset-item' || ev === 'post') rows += num;
  }
  if (rowsRead > rows) { const p = prices['apify-default-dataset-item']?.eventPriceUsd ?? prices.post?.eventPriceUsd ?? rowPrice(actor); eventsUsd += (rowsRead - rows) * p; rows = rowsRead; }
  const platformUsd = Number(run.usageTotalUsd) || 0;
  const r4 = x => Math.round(x * 10000) / 10000;
  return { totalUsd: r4(platformUsd + eventsUsd), platformUsd: r4(platformUsd), resultsUsd: r4(eventsUsd), rows };
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
  // The limits this run was started with (stored by startRun), to tell whether it was cut short.
  const caps = prev?.report?.caps || prev?.report?.progress?.caps || null;
  if (report) delete report.error;
  let offset = report?.progress?.offset || 0;
  const [areas, settings] = await Promise.all([repo.listAreas(), repo.getSettings()]);
  // Group names: rows seen on earlier pages of this dataset, else the weekly stored group details.
  let groups = report?.progress?.groups || settings.groupInfo?.groups || [];
  const groupRows = []; // "group" rows in this dataset: present only when the run asked for group details
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
      const progress = last ? null : pageGroups => ({ offset: nextOffset, groups: mergeGroups(pageGroups), ...(caps ? { caps } : {}) });
      for (const r of items) if (r && typeof r === 'object' && String(r.type).toLowerCase() === 'group' && r.id != null) groupRows.push({ id: String(r.id), name: String(r.name || r.title || '').slice(0, 200), url: String(r.url || ''), privacy: String(r.privacy || '').toLowerCase() });
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
  // Real cost of the run (one Apify call): platform usage + per-row charges. Falls back to a cost passed in.
  let cost = null;
  if (runId) { try { cost = runCost((await apify(env, `/actor-runs/${encodeURIComponent(runId)}`, {}, fetchFn))?.data, actorId(env), offset); } catch { /* cost stays unknown */ } }
  if (!cost && typeof costUsd === 'number' && isFinite(costUsd)) cost = { totalUsd: Math.round(costUsd * 10000) / 10000 };
  const truncated = truncation(report, caps, offset, cost);
  if (cost || truncated) await repo.annotateRun(datasetId, { costUsd: cost?.totalUsd ?? null, cost, truncated });
  if (cost) report.cost = cost;
  if (truncated) report.truncated = truncated;
  const patch = { unscrapableGroups: { at: now, datasetId, groups: (report.unscrapable || []).slice(0, 50) } };
  // A group-details run refreshes the stored details even when nothing changed, so they stop being stale.
  if (groupRows.length) {
    const watched = (Array.isArray(settings.groups) ? settings.groups : []).filter(g => g.url && !isPage(g)).map(g => g.url);
    patch.groupInfo = { at: now, urls: watched, groups: [...new Map(groupRows.map(g => [g.id, g])).values()].slice(0, 200) };
  }
  await repo.putSettings(patch);
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
    const res = await ingestDataset(repo, env, { datasetId: r.defaultDatasetId, runId: r.id, startedAt: Date.parse(r.startedAt) || null, }, { fetchFn, now, maxPages: SWEEP_PAGES });
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
  let perGroup = Math.min(MAX_RESULTS_PER_GROUP, Number(settings.resultsPerGroup) || DEFAULT_RESULTS_PER_GROUP);
  let usage = null, detail = pageNote;
  try {
    usage = await getUsage(env, fetchFn);
    await repo.putSettings({ apifyUsage: { ...usage, checkedAt: now } });
  } catch (e) { detail += 'Could not read Apify usage (' + e.message + '); started anyway. '; }
  if (usage && usage.ratio > sch.budgetStopPct / 100) return { action: 'skipped', detail: `Apify credit ${Math.round(usage.ratio * 100)}% used ($${usage.usedUsd} of $${usage.limitUsd}). Runs resume when the monthly cycle resets.` };
  if (usage && usage.ratio > sch.budgetWarnPct / 100) { perGroup = Math.max(5, Math.floor(perGroup / 2)); detail += `Credit ${Math.round(usage.ratio * 100)}% used, so ${perGroup} posts per group. `; }
  // Normal: posts since the last good run. If that run was cut short by its limits, fetch its window
  // again once with the largest posts-per-group, so the posts it could not return are picked up.
  // A recovery run that is cut short too is accepted (shown in the run report) to avoid paying in a loop.
  const lastRun = await repo.lastGoodRun();
  let after = cutoffFor(lastRun?.startedAt ?? null, sch, now), recover = false;
  const tr = lastRun?.truncated;
  if (tr && !tr.recover && tr.after) {
    after = Math.max(tr.after, cutoffFor(null, sch, now)); recover = true;
    perGroup = MAX_RESULTS_PER_GROUP;
    detail += `The last run hit its limits, so this run re-reads its window with ${perGroup} posts per group. `;
  }
  const actor = actorId(env);
  const groupInfo = groupInfoStale(settings, groups, now);
  const input = buildInput(actor, { groups, resultsPerGroup: perGroup, after, groupInfo });
  // Hard caps Apify enforces on the run: at most this many dataset rows, and at most maxRunUsd of
  // per-row charges (the run stops there), so a misbehaving actor can never drain the month's credit.
  const maxItems = groups.length * perGroup + (groupInfo ? groups.length : 0) + 5;
  const maxCharge = Math.max(0.01, Math.min(Number(sch.maxRunUsd) || SCHEDULE_DEFAULTS.maxRunUsd, Math.ceil(maxItems * rowPrice(actor) * 1.2 * 100) / 100));
  const hook = webhookParam(env);
  const qs = new URLSearchParams({ maxItems: String(maxItems), maxTotalChargeUsd: String(maxCharge) });
  if (hook) qs.set('webhooks', hook);
  const { data } = await apify(env, `/acts/${actor}/runs?${qs}`, { method: 'POST', body: JSON.stringify(input) }, fetchFn);
  if (data?.id && isDatasetId(data.defaultDatasetId)) await repo.recordStartedRun({ runId: data.id, datasetId: data.defaultDatasetId, startedAt: Date.parse(data.startedAt) || now, actor, caps: { perGroup, maxItems, maxCharge, after, recover } });
  if (!hook) detail += 'PUBLIC_BASE_URL or INGEST_SECRET is not set, so results arrive with the next sweep instead of a webhook. ';
  if (groupInfo) detail += 'Group details refreshed this run. ';
  return { action: 'started', runId: data?.id, groups: groups.length, skippedPages: pages.length, resultsPerGroup: perGroup, after, maxItems, maxChargeUsd: maxCharge, groupInfo, detail: detail.trim() };
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
    const due = force || isDue(sch, prev.lastStartedAt, now);
    if (due) {
      try { const r = await startRun(repo, env, { fetchFn, now, settings }); status.action = r.action; status.detail = r.detail ? r.detail + ' ' : ''; status.runId = r.runId; if (r.action === 'started') status.lastStartedAt = now; }
      catch (e) { status.action = 'error'; status.detail = 'Start failed: ' + e.message + '. '; }
      await repo.putSettings({ scheduler: { ...status, detail: status.detail.trim() } });
    } else status.action = sch.enabled ? 'not_due' : 'paused';
    try { status.swept = await sweep(repo, env, { fetchFn, now }); } catch (e) { status.detail += 'Sweep failed: ' + e.message + '.'; }
  }
  if (!force) await extras(repo, env, settings, sch, status, { fetchFn, now });
  status.detail = status.detail.trim();
  status.nextRunAt = nextRunAt({ ...settings, scheduler: status }, now + 1);
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
