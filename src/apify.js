// Apify integration (docs/APIFY.md): our cron starts runs itself, Apify calls our webhook when a run
// succeeds, and the cron also sweeps recent succeeded runs in case a webhook was missed.
// Dataset reads are paged; progress is saved per page so a cut-off invocation resumes later.

import { ingestItems } from './ingest.js';

export const API = 'https://api.apify.com/v2';
export const DEFAULT_ACTOR = 'automly~facebook-public-group-posts-scraper';
export const OFFICIAL_ACTOR = 'apify~facebook-groups-scraper';
export const DEFAULT_RESULTS_PER_GROUP = 25;
const HOUR = 36e5;
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
// Small pages so that one page always fits in the Workers Free 10 ms CPU budget: an invocation
// cut off mid-way still saved every finished page, so each retry makes progress.
export const pageSize = env => Math.min(500, Math.max(10, parseInt(env.INGEST_PAGE_SIZE, 10) || 25));

// No `fields=`: the actors' real column names are unverified (docs/APIFY.md), and a name missing
// from a whitelist would silently drop data. Omit only comment columns, which can be large and
// which normalizeRaw/collectImages ignore anyway (collectImages skips keys matching /comments?/).
export const DATASET_OMIT = ['topComments', 'latestComments', 'comments'];

async function apify(env, path, init = {}, fetchFn = fetch) {
  if (!env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set');
  const r = await fetchFn(API + path, { ...init, headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Apify ${init.method || 'GET'} ${path.split('?')[0]} -> HTTP ${r.status}`);
  return r.json();
}

/** Input for the configured actor. Each actor names things differently. */
export function buildInput(actor, { groups, resultsPerGroup, after }) {
  const urls = groups.map(g => g.url);
  const iso = new Date(after).toISOString();
  if (actor === OFFICIAL_ACTOR) return { startUrls: urls.map(url => ({ url })), resultsLimit: resultsPerGroup, viewOption: 'CHRONOLOGICAL', onlyPostsNewerThan: iso };
  return { groups: urls, resultsPerGroup, sortOrder: 'new', postsPublishedAfter: iso, includeGroupInfo: true };
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
export async function ingestDataset(repo, env, { datasetId, runId, startedAt }, { fetchFn = fetch, now = Date.now(), maxPages = MAX_PAGES } = {}) {
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
      const res = await ingestItems(repo, items, { source: 'apify', now, datasetId, areas, settings, groups, run: { status: last ? 'done' : partial ? 'partial' : 'ingesting', report, progress } });
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
    const res = await ingestDataset(repo, env, { datasetId: r.defaultDatasetId, runId: r.id, startedAt: Date.parse(r.startedAt) || null }, { fetchFn, now, maxPages: SWEEP_PAGES });
    out.push({ datasetId: r.defaultDatasetId, status: res.status, newListings: res.report?.newListings ?? 0 });
    if (res.status !== 'skipped') break;
  }
  return out;
}

/** Budget check, then start a run for the active watched groups. */
export async function startRun(repo, env, { fetchFn = fetch, now = Date.now() } = {}) {
  const settings = await repo.getSettings();
  const groups = (Array.isArray(settings.groups) ? settings.groups : []).filter(g => g.active !== false && g.url);
  if (!groups.length) return { action: 'skipped', detail: 'No active watched groups with a link. Add them in Settings.' };
  let perGroup = Number(settings.resultsPerGroup) || DEFAULT_RESULTS_PER_GROUP;
  let usage = null, detail = '';
  try {
    usage = await getUsage(env, fetchFn);
    await repo.putSettings({ apifyUsage: { ...usage, checkedAt: now } });
  } catch (e) { detail = 'Could not read Apify usage (' + e.message + '); started anyway. '; }
  if (usage && usage.ratio > 0.95) return { action: 'skipped', detail: `Apify credit ${Math.round(usage.ratio * 100)}% used ($${usage.usedUsd} of $${usage.limitUsd}). Runs resume when the monthly cycle resets.` };
  if (usage && usage.ratio > 0.8) { perGroup = Math.max(5, Math.floor(perGroup / 2)); detail += `Credit ${Math.round(usage.ratio * 100)}% used, so ${perGroup} posts per group. `; }
  const lastStart = await repo.lastSuccessfulStart();
  const after = Math.max(lastStart ? lastStart - HOUR : now - 24 * HOUR, now - 3 * 24 * HOUR);
  const actor = actorId(env);
  const input = buildInput(actor, { groups, resultsPerGroup: perGroup, after });
  const hook = webhookParam(env);
  const { data } = await apify(env, `/acts/${actor}/runs${hook ? `?webhooks=${encodeURIComponent(hook)}` : ''}`, { method: 'POST', body: JSON.stringify(input) }, fetchFn);
  if (data?.id && isDatasetId(data.defaultDatasetId)) await repo.recordStartedRun({ runId: data.id, datasetId: data.defaultDatasetId, startedAt: Date.parse(data.startedAt) || now });
  if (!hook) detail += 'PUBLIC_BASE_URL or INGEST_SECRET is not set, so results arrive with the next sweep instead of a webhook. ';
  return { action: 'started', runId: data?.id, groups: groups.length, resultsPerGroup: perGroup, after, detail: detail.trim() };
}

/**
 * The cron job: start the next run first, then sweep. Starting first means a sweep that fails (or
 * an invocation cut off by the CPU limit while sweeping) can never stop new runs from starting.
 */
export async function scheduledJob(repo, env, { fetchFn = fetch, now = Date.now() } = {}) {
  if (!env.APIFY_TOKEN) return { action: 'skipped', detail: 'APIFY_TOKEN is not set.' };
  const status = { at: now, swept: [], action: '', detail: '' };
  try { const r = await startRun(repo, env, { fetchFn, now }); status.action = r.action; status.detail = r.detail ? r.detail + ' ' : ''; status.runId = r.runId; }
  catch (e) { status.action = 'error'; status.detail = 'Start failed: ' + e.message + '. '; }
  await repo.putSettings({ scheduler: { ...status, detail: status.detail.trim() } });
  try { status.swept = await sweep(repo, env, { fetchFn, now }); } catch (e) { status.detail += 'Sweep failed: ' + e.message + '.'; }
  status.detail = status.detail.trim();
  await repo.putSettings({ scheduler: status });
  return status;
}
