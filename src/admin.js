// Admin API (/api/admin/*). The router has already checked that the caller is an admin.
import { HttpError, json, errorJson, readJson } from './http.js';
import { ingestItems } from './ingest.js';
import { scheduledJob, startRun, sweep, getUsage, scheduleOf, nextRunAt, actorId, DEFAULT_RESULTS_PER_GROUP, MAX_RESULTS_PER_GROUP, budgeted, rowPrice, groupInfoStale, runGroupPlan, DEFAULT_ACTOR } from './apify.js';
import { planOf, PLAN_LIMITS, PLAN_DEFAULTS, groupStats, dailyAllowance, budgetOf, manualAction, projectedDailyUsd, isReading } from './groupplan.js';
import { redditStep, redditConfigured, subredditsOf, validateSubreddits, DEFAULT_SUBREDDITS } from './reddit.js';
import { validateGroups, groupsView, groupId, classifyFacebookUrl, PAGE_WARNING } from './groups.js';
import { editArea, areaName, LIMITS } from './app.js';
import { cleanKeywords } from './core/keywords.js';
import { watchedGroups, isKnownGroup } from './core/logic.js';
import { backfillState } from './backfill.js';
import { adminEmails } from './auth.js';
import { aiStatus, acceptSuggestion, aiConfigOf, runEnrich } from './ai.js';
import { financeView, validateBudget } from './finance.js';
import { alertsAdminApi } from './alerts.js';

const DAY = 864e5;
const int = v => (v != null && /^\d{1,15}$/.test(String(v)) ? Number(v) : null);
const clampInt = (v, lo, hi, def) => { const n = int(v); return n == null ? def : Math.min(hi, Math.max(lo, n)); };
const dayKey = t => new Date(t + 5.5 * 36e5).toISOString().slice(0, 10); // IST calendar day

/** Normalised per-run stats for the run log and charts (works for Apify, Reddit, phone and paste runs). */
export function runView(r) {
  const p = r.report || {};
  const total = p.total || 0;
  const offArea = (p.offTopic || 0) + (p.offArea || 0);
  const matched = Math.max(0, total - (p.noText || 0) - (p.notHousing || 0) - offArea);
  const finished = r.finishedAt || (r.status === 'done' ? r.at : null);
  return {
    id: r.id, source: r.source, status: r.status, actor: r.actor || (r.source === 'apify' ? 'apify' : r.source), datasetId: r.datasetId, runId: r.runId,
    startedAt: r.startedAt || null, finishedAt: finished, durationMs: r.startedAt && finished ? Math.max(0, finished - r.startedAt) : null,
    postsFetched: total, matchedArea: matched, newListings: p.newListings || 0, merged: p.merged || 0, duplicates: p.dupes || 0,
    offArea, notHousing: p.notHousing || 0, seeking: p.seeking || 0, unscrapableGroups: Array.isArray(p.unscrapable) ? p.unscrapable : [],
    outsideGroups: p.outsideGroups || {}, costUsd: r.costUsd ?? null, cost: p.cost || null, truncated: p.truncated || null, progressOffset: p.progress?.offset ?? null, error: p.error || (p.errors || [])[0] || null,
  };
}

async function scraperView(repo, env, fetchFn, { live = true } = {}) {
  const s = await repo.getSettings();
  let usage = s.apifyUsage || null;
  if (live && env.APIFY_TOKEN) { try { usage = { ...(await getUsage(env, fetchFn)), checkedAt: Date.now() }; await repo.putSettings({ apifyUsage: usage }); } catch { /* keep cached */ } }
  let actor = null; try { actor = actorId(env); } catch { actor = 'invalid'; }
  return {
    schedule: scheduleOf(s), resultsPerGroup: Math.min(MAX_RESULTS_PER_GROUP, s.resultsPerGroup || DEFAULT_RESULTS_PER_GROUP), maxResultsPerGroup: MAX_RESULTS_PER_GROUP,
    groupInfo: s.groupInfo ? { at: s.groupInfo.at, groups: (s.groupInfo.groups || []).length } : null,
    apifyUsage: usage, nextRunAt: env.APIFY_TOKEN ? nextRunAt(s) : null, scheduler: s.scheduler || null, purge: s.purge || null,
    apify: { configured: !!env.APIFY_TOKEN, actor, webhook: !!(env.PUBLIC_BASE_URL && env.INGEST_SECRET) },
    reddit: { configured: redditConfigured(env), state: redditState(s) },
    unscrapableGroups: s.unscrapableGroups || null,
  };
}
const redditState = s => { const r = s.reddit || {}; return { lastRun: r.lastRun || null, inProgress: !!r.cycle, lastStartedAt: r.lastStartedAt || null }; };

function validateSchedule(b, cur) {
  const out = { ...cur };
  const num = (k, lo, hi) => { if (b[k] === undefined) return; const n = Number(b[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, 'bad_' + k, `${k} must be a whole number from ${lo} to ${hi}.`); out[k] = n; };
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'bad_enabled'); out.enabled = b.enabled; }
  if (b.redditEnabled !== undefined) { if (typeof b.redditEnabled !== 'boolean') throw new HttpError(400, 'bad_redditEnabled'); out.redditEnabled = b.redditEnabled; }
  num('intervalHours', 1, 24); num('budgetWarnPct', 10, 99); num('budgetStopPct', 11, 100); num('retentionDays', 7, 365); num('backfillDays', 1, 5); num('overlapMin', 1, 60);
  if (b.mode !== undefined) { if (b.mode !== 'times' && b.mode !== 'interval') throw new HttpError(400, 'bad_mode', 'mode must be "times" or "interval".'); out.mode = b.mode; }
  if (b.runHoursIst !== undefined) {
    if (!Array.isArray(b.runHoursIst) || b.runHoursIst.length > 24 || !b.runHoursIst.every(h => Number.isInteger(h) && h >= 0 && h <= 23)) throw new HttpError(400, 'bad_runHoursIst', 'Run hours must be whole hours from 0 to 23 (IST).');
    out.runHoursIst = [...new Set(b.runHoursIst)].sort((x, y) => x - y);
  }
  if (out.mode === 'times' && !(out.runHoursIst || []).length) throw new HttpError(400, 'bad_runHoursIst', 'Pick at least one run hour.');
  if (b.maxRunUsd !== undefined) { const n = Number(b.maxRunUsd); if (!(n >= 0.01 && n <= 5)) throw new HttpError(400, 'bad_maxRunUsd', 'The per-run limit must be $0.01 to $5.'); out.maxRunUsd = Math.round(n * 100) / 100; }
  if (out.budgetStopPct <= out.budgetWarnPct) throw new HttpError(400, 'bad_budget', 'The stop threshold must be above the warn threshold.');
  return out;
}

const actorDefault = 'automly~facebook-public-group-posts-scraper';
// A paid group is "low value" when, over the window, it returned enough posts to judge (20+) but under
// 15% of them became new listings: most of its spend goes on reposts, chatter or non-housing posts.
export const LOW_VALUE = { minPosts: 20, minYield: 0.15 };
/** Add match rate, spend, listings per dollar and a low-value flag to a per-group stats row. */
export function groupValue(g) {
  const cost = Math.round((g.costUsd || 0) * 10000) / 10000;
  const yieldRate = g.postsFetched ? g.newListings / g.postsFetched : null;
  return {
    ...g, costUsd: cost,
    matchRate: g.postsFetched ? Math.round(1000 * g.matched / g.postsFetched) / 10 : null,
    yieldPct: yieldRate == null ? null : Math.round(1000 * yieldRate) / 10,
    listingsPerUsd: cost > 0 ? Math.round(g.newListings / cost) : null,
    lowValue: cost > 0 && g.postsFetched >= LOW_VALUE.minPosts && yieldRate < LOW_VALUE.minYield,
  };
}

/** Add one run's per-group posts, matches, new listings, spend and failures into a Map of group rows (feed groupValue). */
export function addRunToGroups(groups, r, v, t) {
  const p = r.report || {};
  // Each fetched Apify row is charged, so a group's spend is its rows times the actor's row price.
  const price = r.source === 'apify' ? rowPrice(r.actor || actorDefault) : 0;
  for (const [g, n] of Object.entries(p.fetchedByGroup || {})) { const x = groups.get(g) || { group: g, source: r.source, postsFetched: 0, matched: 0, newListings: 0, failures: 0, lastSeenAt: null, costUsd: 0 }; x.postsFetched += n; x.costUsd = (x.costUsd || 0) + n * price; x.lastSeenAt = Math.max(x.lastSeenAt || 0, t); groups.set(g, x); }
  for (const [g, n] of Object.entries(p.matchedByGroup || {})) { const x = groups.get(g); if (x) x.matched += n; }
  for (const [g, n] of Object.entries(p.newByGroup || {})) { const x = groups.get(g); if (x) x.newListings += n; }
  for (const u of v.unscrapableGroups) { const k = u.name || u.url; const x = groups.get(k) || { group: k, url: u.url, source: r.source, postsFetched: 0, matched: 0, newListings: 0, failures: 0, lastSeenAt: null, costUsd: 0 }; x.failures++; x.failReason = u.reason; groups.set(k, x); }
  return groups;
}

/** Per-day, per-source, per-group and per-area numbers for the dashboard. */
async function stats(repo, days, now) {
  const runs = (await repo.runsSince(now - 2 * days * DAY, 2000)).map(r => ({ r, v: runView(r) }));
  const from = now - days * DAY;
  const dayList = []; for (let i = days - 1; i >= 0; i--) dayList.push(dayKey(now - i * DAY));
  const perDay = new Map(dayList.map(d => [d, { day: d, postsFetched: 0, matched: 0, offArea: 0, newListings: 0, merged: 0, bySource: {} }]));
  const groups = new Map(); const sources = {};
  const prev = { postsFetched: 0, matched: 0, newListings: 0, merged: 0 };
  for (const { r, v } of runs) {
    const t = r.startedAt || r.at;
    if (t < from) { prev.postsFetched += v.postsFetched; prev.matched += v.matchedArea; prev.newListings += v.newListings; prev.merged += v.merged; continue; }
    const d = perDay.get(dayKey(t));
    if (d) {
      d.postsFetched += v.postsFetched; d.matched += v.matchedArea; d.offArea += v.offArea; d.newListings += v.newListings; d.merged += v.merged;
      const bs = d.bySource[r.source] ||= { postsFetched: 0, matched: 0, newListings: 0 }; bs.postsFetched += v.postsFetched; bs.matched += v.matchedArea; bs.newListings += v.newListings;
    }
    const so = sources[r.source] ||= { runs: 0, postsFetched: 0, matched: 0, newListings: 0, merged: 0, failed: 0, costUsd: 0, lastRunAt: null };
    so.runs++; so.postsFetched += v.postsFetched; so.matched += v.matchedArea; so.newListings += v.newListings; so.merged += v.merged; if (r.status === 'failed') so.failed++; so.costUsd += v.costUsd || 0; so.lastRunAt = Math.max(so.lastRunAt || 0, t);
    addRunToGroups(groups, r, v, t);
  }
  for (const d of perDay.values()) d.matchRate = d.postsFetched ? Math.round(1000 * d.matched / d.postsFetched) / 10 : null;
  const totals = [...perDay.values()].reduce((a, d) => ({ postsFetched: a.postsFetched + d.postsFetched, matched: a.matched + d.matched, newListings: a.newListings + d.newListings, merged: a.merged + d.merged }), { postsFetched: 0, matched: 0, newListings: 0, merged: 0 });
  return {
    days, from, perDay: [...perDay.values()], totals, previous: prev,
    sources, groups: [...groups.values()].map(groupValue).sort((a, b) => b.newListings - a.newListings || b.postsFetched - a.postsFetched),
    areas: (await repo.areaStats(now)).map(a => ({ id: a.id, name: a.name, active: a.active, listings: a.listings, listings7d: a.listings7d, users: a.users })),
  };
}

/** Generic sources view: Facebook via Apify, Reddit direct, phone scans. */
/** groupPlan PUT body: enabled (boolean) and the tunables in PLAN_LIMITS (JSON numbers in range). */
export function validatePlan(b, cur) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_body');
  const out = { ...PLAN_DEFAULTS, ...cur };
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'bad_enabled', 'enabled must be true or false.'); out.enabled = b.enabled; }
  for (const [k, [lo, hi, whole]] of Object.entries(PLAN_LIMITS)) {
    if (b[k] === undefined) continue;
    const n = b[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi || (whole && !Number.isInteger(n))) throw new HttpError(400, 'bad_' + k, `${k} must be ${whole ? 'a whole number' : 'a number'} from ${lo} to ${hi}.`);
    out[k] = whole ? n : Math.round(n * 10000) / 10000;
  }
  if (out.normalPer6h >= out.hotPer6h) throw new HttpError(400, 'bad_tiers', 'The hot threshold must be above the normal threshold.');
  if (out.earlyMinYield > out.minYield) throw new HttpError(400, 'bad_yield', 'The early-pause yield must not be above the minimum yield.');
  return out;
}

/** Admin "Group performance" (#admin-groups-performance). D1: settings 1 + runs 1. */
export async function groupPlanView(repo, env, now) {
  const s = await repo.getSettings();
  const plan = planOf(s); const state = s.groupState && typeof s.groupState === 'object' ? s.groupState : {};
  let actor = DEFAULT_ACTOR; try { actor = actorId(env); } catch { /* default price */ }
  const price = rowPrice(actor);
  const usage = s.apifyUsage || null;
  const cycleStart = Date.parse(usage?.cycleStart || '') || now - 30 * DAY;
  const rows = await repo.groupRuns(Math.min(now - 7 * DAY, cycleStart), 2000);
  const failSince = {}; for (const [id, x] of Object.entries(state)) if (x?.at) failSince[id] = x.at;
  const since = {}; for (const [id, x] of Object.entries(state)) if (x?.status === 'trial' && x.since) since[id] = x.since;
  const stats = groupStats(rows, s, { now, cycleStart, price, since, failSince });
  const pace = dailyAllowance({ budgetUsd: budgetOf(s), usage, now });
  const watched = groupsView(s.groups).filter(g => g.supported);
  const nameOf = id => { const w = watched.find(g => g.id === id); return w ? (w.name || w.url) : null; };
  const pct = x => x == null ? null : Math.round(x * 1000) / 10;
  const groups = watched.map(g => {
    const st = stats[g.id] || {}; const x = state[g.id] || {};
    const hist = Array.isArray(x.history) ? x.history : [];
    return {
      id: g.id, name: g.name || '', url: g.url, enabled: g.active,
      status: g.active ? (x.status || null) : 'off', why: g.active ? (x.why || null) : 'turned off in Groups', at: x.at || null, manual: !!x.manual,
      tier: x.tier || null, mode: x.mode || null, coverage: x.coverage ?? null, lookbackH: x.lookbackH ?? null,
      posts7d: st.rows7 || 0, usable7d: st.usable7 || 0, postsCycle: st.rowsCycle || 0, usableCycle: st.usableCycle || 0,
      yieldPct: pct(st.rawYield), smoothedYieldPct: st.rows7 != null ? pct(st.yield) : null, usablePer6h: st.per6h == null ? null : Math.round(st.per6h * 10) / 10,
      crossSharePct: pct(st.crossShare || 0), echoOf: st.echoOf ? nameOf(st.echoOf) : null, echo: !!x.echo,
      spend7dUsd: st.usd7 || 0, spendCycleUsd: st.usdCycle || 0, listingsPerUsd: st.usdCycle > 0 ? Math.round(st.usableCycle / st.usdCycle) : null,
      failures: st.fails || 0, lastSeenAt: st.lastSeenAt || null, lastRead: x.lastRead || null,
      trialEndsAt: x.status === 'trial' && x.since ? x.since + plan.trialDays * DAY : null, trialSpendUsd: x.status === 'trial' ? st.trial?.usd || 0 : null,
      lastEvent: hist.at(-1) || null, history: hist,
    };
  });
  const log = groups.flatMap(g => g.history.map((e, i) => ({ ...e, i, id: g.id, name: g.name || g.url }))).sort((a, b) => b.at - a.at || b.i - a.i).slice(0, 30).map(({ i, ...e }) => e);
  const ids = watched.filter(g => g.active).map(g => g.id);
  const daily = projectedDailyUsd(state, stats, plan, price, ids);
  const used = usage?.usedUsd ?? 0;
  return {
    plan, limits: PLAN_LIMITS,
    summary: {
      enabled: plan.enabled, reading: ids.filter(id => isReading(state[id])).length, minActive: plan.minActive,
      pool: ids.filter(id => state[id]?.status === 'paused' && !state[id]?.manual && state[id]?.why !== 'budget').length,
      budgetUsd: budgetOf(s), allowanceUsd: pace.allowanceUsd, capUsd: pace.capUsd, daysLeft: pace.daysLeft, spentUsd: used,
      projectedDailyUsd: daily, projectedCycleUsd: Math.round((used + daily * pace.daysLeft) * 100) / 100,
      lastAllocationAt: s.groupPlanRun?.at || null, apifyConfigured: !!env.APIFY_TOKEN,
    },
    groups, log,
  };
}

async function sourcesView(repo, env, now) {
  const s = await repo.getSettings();
  const st = await stats(repo, 7, now);
  const sv = id => st.sources[id] || { runs: 0, postsFetched: 0, matched: 0, newListings: 0, merged: 0, failed: 0, costUsd: 0, lastRunAt: null };
  const groups = groupsView(s.groups);
  return { sources: [
    { id: 'apify', name: 'Facebook groups (Apify)', connected: !!env.APIFY_TOKEN, enabled: scheduleOf(s).enabled, watched: groups.filter(g => g.active && g.supported).length, unsupported: groups.filter(g => !g.supported).length, lastStatus: s.scheduler?.action || null, lastError: /failed/i.test(s.scheduler?.detail || '') ? s.scheduler.detail : null, nextRunAt: env.APIFY_TOKEN ? nextRunAt(s) : null, last7d: sv('apify') },
    { id: 'reddit', name: 'Reddit (direct API)', connected: redditConfigured(env), enabled: scheduleOf(s).redditEnabled !== false, watched: subredditsOf(s).length, ...redditState(s), lastError: (s.reddit?.lastRun?.errors || [])[0] || null, last7d: sv('reddit') },
    { id: 'phone', name: 'Phone scans', connected: true, enabled: true, last7d: sv('phone') },
  ] };
}

export async function adminApi(request, env, method, path, url, repo, fetchFn, who) {
  const seg = path.split('/').slice(3); // after /api/admin
  const [res, id, sub] = seg;
  const now = Date.now();
  const q = url.searchParams;
  const body = () => readJson(request, LIMITS.smallBytes);

  // Area alerts: switches, counts, test send (src/alerts.js).
  if (res === 'alerts' && !sub) return alertsAdminApi(request, env, method, id, repo, fetchFn, who);

  // ---------- scraper / sources ----------
  if (res === 'scraper' && !id) {
    if (method === 'GET') return json(await scraperView(repo, env, fetchFn));
    if (method === 'PUT') {
      const b = await body(); if (!b || typeof b !== 'object') throw new HttpError(400, 'bad_body');
      const s = await repo.getSettings(); const patch = { schedule: validateSchedule(b, scheduleOf(s)) };
      if (b.resultsPerGroup !== undefined) { const n = Number(b.resultsPerGroup); if (!Number.isInteger(n) || n < 5 || n > MAX_RESULTS_PER_GROUP) throw new HttpError(400, 'bad_resultsPerGroup', `Posts per group must be 5 to ${MAX_RESULTS_PER_GROUP}.`); patch.resultsPerGroup = n; }
      await repo.putSettings(patch);
      return json(await scraperView(repo, env, fetchFn, { live: false }));
    }
  }
  if (res === 'scraper' && id === 'run' && method === 'POST') {
    let b = {}; if ((request.headers.get('content-type') || '').includes('json')) { try { b = await body(); } catch { b = {}; } }
    if (b?.source === 'reddit') {
      if (!redditConfigured(env)) throw new HttpError(503, 'reddit_not_configured', 'Reddit is not connected: set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.');
      const r = budgeted(repo); const s = await r.getSettings();
      return json({ reddit: await redditStep(r, env, { fetchFn, now, settings: s, sch: scheduleOf(s), budget: r.left() - 4, force: true }) });
    }
    if (!env.APIFY_TOKEN) throw new HttpError(503, 'apify_not_configured', 'APIFY_TOKEN is not set on the server.');
    return json(await scheduledJob(repo, env, { fetchFn, now, force: true }));
  }
  if (res === 'finance' && !id) {
    if (method === 'GET') return json(await financeView(repo, env, fetchFn, { now, refresh: q.get('refresh') === '1' }));
    if (method === 'PUT') { const b = await body(); const budget = { monthlyUsd: validateBudget(b?.monthlyBudgetUsd), updatedAt: now }; await repo.putSettings({ budget }); return json({ budget }); }
  }
  if (res === 'sources' && !id && method === 'GET') return json(await sourcesView(repo, env, now));
  if (res === 'subreddits' && !id) {
    if (method === 'GET') { const s = await repo.getSettings(); return json({ subreddits: Array.isArray(s.subreddits) ? s.subreddits : DEFAULT_SUBREDDITS, connected: redditConfigured(env) }); }
    if (method === 'PUT') { const list = validateSubreddits((await body())?.subreddits); if (!list) throw new HttpError(400, 'bad_subreddits', 'Use subreddit names like bangalorerentals (at most 30).'); await repo.putSettings({ subreddits: list }); return json({ subreddits: list, connected: redditConfigured(env) }); }
  }
  if (res === 'runs' && !id && method === 'GET') {
    const source = q.get('source'); if (source && !/^[a-z]{2,20}$/.test(source)) throw new HttpError(400, 'bad_source');
    return json({ runs: (await repo.listRuns(clampInt(q.get('limit'), 1, 200, 50), { source })).map(runView) });
  }
  if (res === 'stats' && !id && method === 'GET') return json(await stats(repo, clampInt(q.get('days'), 1, 90, 30), now));

  // ---------- watched groups ----------
  if (res === 'groups') {
    const s = await repo.getSettings(); const list = Array.isArray(s.groups) ? s.groups : [];
    const save = async next => {
      const v = validateGroups(next); await repo.putSettings({ groups: v.groups });
      // Group plan on: a new, removed or switched group is placed (or dropped) right away, not at the next daily run.
      if (planOf(s).enabled) await runGroupPlan(repo, await repo.getSettings(), { now, env });
      return json({ groups: groupsView(v.groups), warnings: v.warnings });
    };
    const st = s.groupState && typeof s.groupState === 'object' ? s.groupState : {};
    const withPlan = gs => gs.map(g => st[g.id]?.status ? { ...g, plan: { status: st[g.id].status, why: st[g.id].why || null, tier: st[g.id].tier || null } } : g);
    if (!id && method === 'GET') return json({ groups: withPlan(groupsView(list)), planEnabled: planOf(s).enabled });
    if (!id && method === 'PUT') return save((await body())?.groups);
    if (!id && method === 'POST') {
      const b = await body(); const c = classifyFacebookUrl(b?.url);
      if (!c) throw new HttpError(400, 'bad_group_url', 'Use a facebook.com/groups/… link (paste the full link).');
      if (list.some(g => groupId(g.url) === groupId(c.url))) throw new HttpError(409, 'duplicate_group', 'That group is already watched.');
      return save([...list, { name: typeof b?.name === 'string' ? b.name : '', url: c.url, active: b?.active !== false }]);
    }
    if (id && !sub) {
      const i = list.findIndex(g => groupId(g.url) === id); if (i < 0) return errorJson(404, 'not_found');
      if (method === 'DELETE') return save(list.filter((_, j) => j !== i));
      if (method === 'PATCH') { const b = await body(); const g = { ...list[i] }; if (typeof b?.name === 'string') g.name = b.name; if (typeof b?.active === 'boolean') g.active = b.active; if (typeof b?.url === 'string') g.url = b.url; return save(list.map((x, j) => j === i ? g : x)); }
    }
  }

  // ---------- group plan (#admin-groups-performance) ----------
  if (res === 'group-plan') {
    if (!id && method === 'GET') return json(await groupPlanView(repo, env, now));
    if (!id && method === 'PUT') {
      const s = await repo.getSettings();
      const plan = validatePlan(await body(), planOf(s));
      await repo.putSettings({ groupPlan: plan });
      if (plan.enabled) await runGroupPlan(repo, await repo.getSettings(), { now, env });
      return json(await groupPlanView(repo, env, now));
    }
    if (id && !sub && method === 'POST') {
      if (!/^g[0-9a-z]{1,16}$/.test(id)) throw new HttpError(400, 'bad_id');
      const s = await repo.getSettings();
      if (!groupsView(s.groups).some(g => g.id === id && g.supported)) return errorJson(404, 'not_found');
      const cur = (s.groupState && typeof s.groupState === 'object' ? s.groupState : {})[id];
      const next = manualAction(cur, (await body())?.action, now);
      if (!next) throw new HttpError(400, 'bad_action', 'action must be pause, promote or resume.');
      const { lastRead, recoverNext, ...rest } = next;
      await repo.patchSettings('groupState', { [id]: rest });
      return json(await groupPlanView(repo, env, now));
    }
  }

  // ---------- areas ----------
  if (res === 'areas') {
    if (!id && method === 'GET') { const s = await repo.getSettings(); return json({ areas: (await repo.areaStats(now)).map(a => ({ ...a, matching: !!backfillState(s, a.id) })) }); }
    const aid = int(id); if (id && aid == null) throw new HttpError(400, 'bad_id');
    const cur = aid != null ? await repo.getArea(aid) : null;
    if (id && !cur) return errorJson(404, 'not_found');
    if (cur && !sub && method === 'PATCH') return json(await editArea(repo, cur, await body(), now));
    if (cur && !sub && method === 'DELETE') { await repo.deleteArea(aid); return new Response(null, { status: 204 }); }
    if (cur && sub === 'merge' && method === 'POST') {
      const into = int((await body())?.into); const target = into != null && into !== aid ? await repo.getArea(into) : null;
      if (!target) throw new HttpError(400, 'bad_target', 'Pick another area to merge into.');
      return json(await repo.mergeAreas(aid, into, cleanKeywords([...target.keywords, ...cur.keywords])));
    }
  }

  // ---------- users ----------
  if (res === 'users') {
    if (!id && method === 'GET') { const env_ = adminEmails(env); return json({ users: (await repo.listUsers()).map(u => ({ ...u, envAdmin: env_.includes(String(u.email).toLowerCase()) })), requireApproval: (await repo.getSettings()).requireApproval === true }); }
    if (id && method === 'PATCH') {
      const uid = int(id); if (uid == null) throw new HttpError(400, 'bad_id');
      const b = await body();
      if (b?.role !== undefined && !['admin', 'user'].includes(b.role)) throw new HttpError(400, 'bad_role');
      if (b?.status !== undefined && !['active', 'pending', 'blocked'].includes(b.status)) throw new HttpError(400, 'bad_status');
      if (uid === who.user.id && (b?.role === 'user' || (b?.status && b.status !== 'active'))) throw new HttpError(400, 'self_demotion', 'You cannot demote or block yourself.');
      const u = await repo.updateUser(uid, { role: b?.role, status: b?.status });
      return u ? json(u) : errorJson(404, 'not_found');
    }
  }
  if (res === 'settings' && !id) {
    if (method === 'GET') { const s = await repo.getSettings(); return json({ requireApproval: s.requireApproval === true, keywordFilter: s.keywordFilter !== false }); }
    if (method === 'PUT') {
      const b = await body(); const out = {};
      if (b?.requireApproval !== undefined) { if (typeof b.requireApproval !== 'boolean') throw new HttpError(400, 'bad_requireApproval'); out.requireApproval = b.requireApproval; }
      if (b?.keywordFilter !== undefined) { if (typeof b.keywordFilter !== 'boolean') throw new HttpError(400, 'bad_keywordFilter'); out.keywordFilter = b.keywordFilter; }
      if (!Object.keys(out).length) throw new HttpError(400, 'nothing_to_update');
      await repo.putSettings(out); const s = await repo.getSettings();
      return json({ requireApproval: s.requireApproval === true, keywordFilter: s.keywordFilter !== false });
    }
  }

  // ---------- listings ----------
  if (res === 'listings') {
    if (id === 'export' && method === 'GET') {
      const all = (await repo.listListings()).map(({ fp, sk, ...l }) => l);
      return new Response(JSON.stringify({ exportedAt: new Date(now).toISOString(), listings: all }, null, 1), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="flat-hunt-all-${new Date(now).toISOString().slice(0, 10)}.json"` } });
    }
    if (id === 'delete' && method === 'POST') {
      const ids = (await body())?.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x))) throw new HttpError(400, 'bad_ids', 'ids: 1 to 500 listing ids.');
      return json({ deleted: await repo.deleteListings(ids) });
    }
    if (!id && method === 'GET') {
      const qq = (q.get('q') || '').trim().slice(0, 100); const area = q.get('area');
      if (area && int(area) == null) throw new HttpError(400, 'bad_area');
      return json(await repo.searchListings({ q: qq, area: area ? int(area) : null, limit: clampInt(q.get('limit'), 1, 200, 50), offset: clampInt(q.get('offset'), 0, 1e6, 0) }));
    }
    if (id && method === 'DELETE') { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'bad_id'); return (await repo.deleteListings([id])) ? new Response(null, { status: 204 }) : errorJson(404, 'not_found'); }
  }

  // ---------- phone scans ----------
  if (res === 'phone-scan' && !id && method === 'POST') {
    const b = await readJson(request, LIMITS.importBytes);
    const items = Array.isArray(b) ? b : Array.isArray(b?.posts) ? b.posts : Array.isArray(b?.items) ? b.items : null;
    if (!items || !items.length) throw new HttpError(400, 'no_items', 'Send the scan JSON: {"posts": [...]} or an array of posts.');
    if (items.length > LIMITS.importItems) throw new HttpError(413, 'too_many_items', `At most ${LIMITS.importItems} posts per scan.`);
    const clean = items.filter(x => typeof x === 'string' || (x && typeof x === 'object' && !Array.isArray(x)));
    const { report, changed } = await ingestItems(repo, clean, { source: 'phone', now, storeAll: true, env });
    return json({ report, changed: changed.length });
  }
  if (res === 'phone-scans' && !id && method === 'GET') {
    const rawRuns = await repo.listRuns(clampInt(q.get('limit'), 1, 100, 30), { source: 'phone' });
    // "Posts from groups we don't scrape": groups seen in scans that are not active watched groups.
    const s = await repo.getSettings();
    const watched = watchedGroups(s.groups);
    const outside = {};
    for (const r of rawRuns) {
      const p = r.report || {};
      for (const [g, n] of Object.entries(p.fetchedByGroup || {})) {
        if (g === 'Group not detected' || isKnownGroup(g, '', watched)) continue;
        const o = outside[g] ||= { group: g, posts: 0, matched: 0, scans: 0 };
        o.posts += n; o.matched += (p.matchedByGroup || {})[g] || 0; o.scans++;
      }
    }
    const outsideCount = r => Object.entries(r.report?.fetchedByGroup || {}).filter(([g]) => outside[g]).reduce((a, [, n]) => a + n, 0);
    return json({ scans: rawRuns.map(r => ({ ...runView(r), outsideCount: outsideCount(r) })), outsideGroups: Object.values(outside).sort((a, b) => b.posts - a.posts) });
  }

  // ---------- AI extraction ----------
  if (res === 'ai') {
    if (!id && method === 'GET') return json(await aiStatus(repo, env, now));
    if (!id && method === 'PUT') {
      const b = await body(); const cur = aiConfigOf(await repo.getSettings()); const out = { ...cur };
      if (b?.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'bad_enabled'); out.enabled = b.enabled; }
      if (b?.neuronCap !== undefined) { const n = Number(b.neuronCap); if (!Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, 'bad_neuronCap', 'Neuron cap must be 0 to 10,000 a day.'); out.neuronCap = n; }
      if (b?.maxPostsPerDay !== undefined) { const n = Number(b.maxPostsPerDay); if (!Number.isInteger(n) || n < 0 || n > 2000) throw new HttpError(400, 'bad_maxPostsPerDay'); out.maxPostsPerDay = n; }
      await repo.putSettings({ aiConfig: out });
      return json(await aiStatus(repo, env, now));
    }
    if (id === 'run' && method === 'POST') return json(await runEnrich(budgeted(repo), env, { maxCalls: 6, now, fetchFn }));
    if (id === 'retry' && sub && method === 'POST') { if (!/^[A-Za-z0-9_-]{1,40}$/.test(sub)) throw new HttpError(400, 'bad_id'); return (await repo.aiRetry(sub, now)) ? json({ ok: true }) : errorJson(404, 'not_found'); }
    if (id === 'suggestions' && sub && method === 'POST') {
      const sid = int(sub); const sg = sid != null ? await repo.getSuggestion(sid) : null; if (!sg) return errorJson(404, 'not_found');
      const action = (await body())?.action;
      if (action === 'merge') return json({ merged: await acceptSuggestion(repo, sg, now) });
      if (action === 'dismiss') { await repo.setSuggestion(sid, 'dismissed'); return json({ dismissed: true }); }
      throw new HttpError(400, 'bad_action', 'action must be merge or dismiss.');
    }
  }

  return errorJson(404, 'not_found', 'No such admin route.');
}
