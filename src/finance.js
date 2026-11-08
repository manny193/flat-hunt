// Admin "Finance & budget" (docs/design/FINANCE.md): one combined view of what scraping costs this Apify
// billing cycle, the forecast, per-group spend and the free services. GET /api/admin/finance.
// D1 cost: settings (1) + runs since the cycle start or 14 days back (1) + database size (1), plus one
// write when Apify usage is refreshed. Everything else is worked out from those rows in memory.
import { HttpError } from './http.js';
import { getUsage, scheduleOf, nextRunAt, actorId, rowPrice, DEFAULT_ACTOR, DEFAULT_RESULTS_PER_GROUP, MAX_RESULTS_PER_GROUP } from './apify.js';
import { runView, groupValue, addRunToGroups } from './admin.js';
import { groupsView } from './groups.js';
import { redditConfigured } from './reddit.js';
import { aiConfigOf } from './ai.js';

const HOUR = 36e5, DAY = 24 * HOUR, IST = 5.5 * HOUR;
const dayKey = t => new Date(t + IST).toISOString().slice(0, 10); // IST calendar day
const r2 = x => Math.round(x * 100) / 100, r4 = x => Math.round(x * 10000) / 10000;

// Tunables (spec §10 defaults). Kept here so they are easy to change.
export const FINANCE = {
  defaultBudgetUsd: 5,          // settings.budget when the admin never set one (= the Apify free credit)
  budgetMin: 0.5, budgetMax: 500,
  usageMaxAgeMs: 10 * 60e3,     // re-read Apify usage when the cached reading is older than this
  rateWindowDays: 7,            // projection uses the average daily spend over at most this many days
  platformPerRunUsd: 0.00015,   // fallback when no run reports its platform charge
  fallbackPostsPerGroupHour: 1.5,
  freePlanMaxUsd: 5,            // limitUsd at or below this is treated as the Apify free plan
  runsShown: 20,
  // Q1 (spec §10): the budget does NOT drive the Apify warn/stop guard yet. The guard stays relative to
  // the Apify credit (startRun in src/apify.js) until the numbers have been checked against one bill.
  // Exception: with groupPlan on, the daily allowance (src/groupplan.js dailyAllowance) paces runs from
  // min(budget, Apify limit) x 95 % and replaces the warn/stop guard. The forecast below still shows the guard.
};

/** PUT body check: a number of dollars from $0.50 to $500, rounded to cents. */
export function validateBudget(v) {
  // A JSON number, or a plain decimal string ("12" / "12.5" / "12.50"); no hex, exponents or signs.
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < FINANCE.budgetMin || n > FINANCE.budgetMax) throw new HttpError(400, 'bad_budget', 'Enter an amount from $0.50 to $500.');
  return r2(n);
}

const addMonthUtc = (t, k) => { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() + k); return d.getTime(); };
/** Start (ms) of the IST calendar month containing t. */
function istMonthStart(t) { const d = new Date(t + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST; }

/**
 * The billing cycle: Apify's own dates when usage has been read (rolled forward if the cached reading is
 * from an earlier cycle), otherwise the IST calendar month. `current` says whether the usage reading
 * belongs to this cycle (if not, its usedUsd must not be used as this cycle's spend).
 */
export function cycleOf(usage, now) {
  let start = Date.parse(usage?.cycleStart || ''), end = Date.parse(usage?.cycleEnd || ''), source = 'apify', current = !!usage;
  if (!Number.isFinite(end)) { start = istMonthStart(now); end = istMonthStart(start + 40 * DAY); source = 'calendar'; current = false; }
  else {
    if (!Number.isFinite(start)) start = addMonthUtc(end, -1);
    for (let i = 0; end <= now && i < 24; i++) { start = end; end = addMonthUtc(end, 1); current = false; }
  }
  // Day i of the cycle covers [start + i days, start + i + 1 days); it is labelled with the IST date it starts on.
  const daysTotal = Math.max(1, Math.round((end - start) / DAY));
  const days = Array.from({ length: daysTotal }, (_, i) => dayKey(start + i * DAY));
  return { source, start, end, daysTotal, daysElapsed: r2(Math.max(0, now - start) / DAY), daysLeft: r2(Math.max(0, end - now) / DAY), days, current };
}

/** Longest wait between runs: times mode wraps around midnight; interval mode is the interval. */
export function scheduleGaps(sch) {
  const label = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  const hours = [...new Set((sch.runHoursIst || []).filter(h => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
  if (sch.mode === 'interval' || !hours.length) {
    const n = Math.max(1, Number(sch.intervalHours) || 4);
    return { runsPerDay: r2(24 / n), longestGapHours: n, longestGap: `every ${n} h` };
  }
  let best = { from: hours.at(-1), to: hours[0], gap: hours[0] + 24 - hours.at(-1) };
  for (let i = 1; i < hours.length; i++) { const gap = hours[i] - hours[i - 1]; if (gap > best.gap) best = { from: hours[i - 1], to: hours[i], gap }; }
  return { runsPerDay: hours.length, longestGapHours: best.gap, longestGap: `${label(best.from)} to ${label(best.to)}, ${best.gap} h` };
}

/**
 * Forecast and status (spec §8.2). Pure: tests pin it with plain numbers.
 * mtd: spent this cycle; rate: $/day; used/limit: Apify credit (used falls back to mtd); enabled: scraping on.
 */
export function forecastOf({ now, cycle, budget, mtd, mtdSource = 'apify', runsUsd = mtd, rate, rateWindowDays, hasRuns, usage = null, warnPct = 80, stopPct = 95, enabled = true }) {
  const limit = usage?.limitUsd ?? FINANCE.freePlanMaxUsd;
  const used = usage ? usage.usedUsd : mtd;
  const ratio = usage ? usage.ratio : limit > 0 ? used / limit : 1;
  const stopAt = limit * stopPct / 100, warnAt0 = limit * warnPct / 100;
  // Same comparisons as the guard in startRun (src/apify.js): runs stop when ratio > stop%, halve when > warn%.
  const paused = ratio > stopPct / 100;
  const warnHit = ratio > warnPct / 100;
  // Nothing more is spent when scraping is switched off or the guard has paused it.
  const fwd = enabled && !paused ? rate : 0;
  // The guard stops runs once credit used passes the stop level, so spend can't grow past it this cycle.
  const room = Math.max(0, stopAt - used);
  const uncapped = mtd + fwd * cycle.daysLeft;
  const projectionCapped = fwd * cycle.daysLeft > room;
  const projected = projectionCapped ? mtd + room : uncapped;
  const at = target => { if (!(fwd > 0)) return null; if (used >= target) return now; const t = now + ((target - used) / fwd) * DAY; return t < cycle.end ? Math.round(t) : null; };
  const pauseAt = at(stopAt), warnAt = at(warnAt0);
  let budgetAt = null;
  if (mtd >= budget) budgetAt = now;
  else if (fwd > 0) { const t = Math.round(now + ((budget - mtd) / fwd) * DAY); if (t < cycle.end && !(pauseAt != null && pauseAt <= t)) budgetAt = t; }
  const limitHit = !!usage && usage.usedUsd >= usage.limitUsd;
  const over = mtd >= budget || limitHit;
  const pauseSoon = pauseAt != null && pauseAt > now;
  const reason = over ? (limitHit && mtd < budget ? 'credit' : 'budget')
    : paused ? 'paused' : budgetAt != null ? 'projection' : pauseSoon ? 'pause' : warnHit ? 'warn' : null;
  const watch = !over && reason != null;
  const unknown = !over && !watch && (rateWindowDays < 1 || !hasRuns);
  return {
    mtdUsd: r2(mtd), mtdSource, runsUsd: r4(runsUsd), dailyRateUsd: r4(rate), forwardRateUsd: r4(fwd), rateWindowDays: r2(rateWindowDays),
    projectedUsd: r2(projected), uncappedProjectedUsd: r2(uncapped), projectionCapped,
    budgetAt, warnAt, pauseAt, creditUsedUsd: r2(used), limitUsd: limit, paused,
    status: over ? 'over' : watch ? 'watch' : unknown ? 'unknown' : 'ok', reason,
  };
}

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** What a run cost: the recorded charge, else (for an ingested run without one) its rows times the row price. */
const costOf = (r, v) => r.costUsd ?? (r.status === 'done' ? v.postsFetched * rowPrice(r.actor || DEFAULT_ACTOR) : 0);

function freeServices(env, settings, now, sizeBytes) {
  const ai = settings.ai || {}; const today = ai.day === new Date(now).toISOString().slice(0, 10); // Workers AI resets at 00:00 UTC
  const cap = aiConfigOf(settings).neuronCap;
  const out = [
    { id: 'workers', name: 'Cloudflare Workers', plan: 'Workers Free', allowanceText: '100,000 requests a day, 10 ms CPU each', measured: false, used: null, limit: 100000, unit: 'requests', period: 'day', resets: 'daily-utc', note: null },
    { id: 'd1', name: 'Cloudflare D1', plan: 'D1 Free', allowanceText: '5 million rows read and 100,000 written a day, 5 GB stored', measured: sizeBytes != null, used: sizeBytes, limit: 5e9, unit: 'bytes', period: 'storage', resets: null, note: 'Reads and writes not measured yet' },
    { id: 'workers_ai', name: 'Workers AI', plan: 'Workers Free', allowanceText: `10,000 neurons a day (our cap ${cap.toLocaleString('en-US')})`, measured: true, used: today ? ai.neurons || 0 : 0, limit: 10000, unit: 'neurons', period: 'day', resets: 'daily-utc', note: env.AI ? null : 'Workers AI binding not set' },
  ];
  if (env.GROQ_API_KEY) out.push({ id: 'groq', name: 'Groq (AI fallback)', plan: 'Free tier', allowanceText: 'Free tier, rate-limited', measured: false, used: null, limit: null, unit: 'tokens', period: 'day', resets: 'daily-utc', note: `${today ? ai.groqTokens || 0 : 0} tokens today` });
  out.push({ id: 'github', name: 'GitHub Actions', plan: 'Free', allowanceText: 'Free for public repos (2,000 min a month if private)', measured: false, used: null, limit: null, unit: 'minutes', period: 'month', resets: 'monthly', note: null });
  const rc = redditConfigured(env);
  out.push({ id: 'reddit', name: 'Reddit API', plan: rc ? 'Free (non-commercial)' : 'Not connected', allowanceText: '100 requests a minute with OAuth', measured: false, used: null, limit: 100, unit: 'requests/min', period: 'minute', resets: null, note: null, connected: rc });
  return out;
}

export async function financeView(repo, env, fetchFn, { now = Date.now(), refresh = false } = {}) {
  const s = await repo.getSettings();
  const configured = !!env.APIFY_TOKEN;
  let usage = configured ? s.apifyUsage || null : null, usageError = null;
  if (configured && (refresh || !usage?.checkedAt || now - usage.checkedAt > FINANCE.usageMaxAgeMs)) {
    try { usage = { ...(await getUsage(env, fetchFn)), checkedAt: now }; await repo.putSettings({ apifyUsage: usage }); }
    catch (e) { usageError = String(e?.message || e).replace(/apify_api_\w+/g, '[token]').slice(0, 200); }
  }
  const sch = scheduleOf(s); const gaps = scheduleGaps(sch);
  const sb = s.budget && typeof s.budget === 'object' ? s.budget : {};
  const okBudget = typeof sb.monthlyUsd === 'number' && sb.monthlyUsd >= FINANCE.budgetMin && sb.monthlyUsd <= FINANCE.budgetMax;
  const budget = okBudget ? { monthlyUsd: sb.monthlyUsd, updatedAt: sb.updatedAt ?? null } : { monthlyUsd: FINANCE.defaultBudgetUsd, updatedAt: null };
  let actor = DEFAULT_ACTOR; try { actor = actorId(env); } catch { /* invalid config: price the default actor */ }
  const cycle = cycleOf(usage, now);
  const usageNow = cycle.current ? usage : null; // a reading from an earlier cycle says nothing about this one
  const from = Math.min(cycle.start, now - 14 * DAY);
  const [rows, sizeBytes] = await Promise.all([repo.runsSince(from, 2000), repo.dbSizeBytes ? repo.dbSizeBytes() : null]);
  const runs = rows.map(r => ({ r, v: runView(r), t: r.startedAt || r.at }));
  const apify = configured ? runs.filter(x => x.r.source === 'apify') : [];
  const inCycle = apify.filter(x => x.t >= cycle.start && x.t < cycle.end);

  // Per day (cycle days up to today) and the money totals.
  const dayIndex = t => Math.min(cycle.daysTotal - 1, Math.floor((t - cycle.start) / DAY));
  const perDay = cycle.days.slice(0, dayIndex(now) + 1).map(d => ({ day: d, costUsd: 0, rowsUsd: 0, otherUsd: 0, rows: 0, runs: 0, newListings: 0 }));
  let runsUsd = 0;
  for (const { r, v, t } of inCycle) {
    const c = costOf(r, v); runsUsd += c;
    const d = perDay[dayIndex(t)]; if (!d) continue;
    const rowsUsd = r.costUsd != null ? (v.cost?.resultsUsd ?? c) : c;
    d.costUsd += c; d.rowsUsd += rowsUsd; d.otherUsd += Math.max(0, c - rowsUsd); d.rows += v.cost?.rows ?? v.postsFetched; d.runs++; d.newListings += v.newListings;
  }
  for (const d of perDay) { d.costUsd = r4(d.costUsd); d.rowsUsd = r4(d.rowsUsd); d.otherUsd = r4(d.otherUsd); }

  // Rate: average daily spend over the last min(7 days, days into the cycle, days since our first run).
  const firstRun = apify.length ? Math.min(...apify.map(x => x.t)) : null;
  const windowDays = firstRun == null ? 0 : Math.min(FINANCE.rateWindowDays, cycle.daysElapsed, (now - firstRun) / DAY);
  const winFrom = now - windowDays * DAY;
  const winUsd = inCycle.filter(x => x.t >= winFrom).reduce((a, x) => a + costOf(x.r, x.v), 0);
  const rate = windowDays > 0 ? winUsd / Math.max(1, windowDays) : 0; // under a day of data: spread over one day, not extrapolated
  const mtd = usageNow ? usageNow.usedUsd : runsUsd;
  const forecast = forecastOf({ now, cycle, budget: budget.monthlyUsd, mtd, mtdSource: usageNow ? 'apify' : 'runs', runsUsd, rate, rateWindowDays: windowDays, hasRuns: inCycle.length > 0, usage: usageNow, warnPct: sch.budgetWarnPct, stopPct: sch.budgetStopPct, enabled: sch.enabled && configured });

  // Cost per new listing: last 7 days vs the 7 before.
  const span = (a, b) => apify.filter(x => x.t >= a && x.t < b).reduce((o, x) => ({ c: o.c + costOf(x.r, x.v), n: o.n + x.v.newListings }), { c: 0, n: 0 });
  const e1 = span(now - 7 * DAY, now + 1), e0 = span(now - 14 * DAY, now - 7 * DAY);
  const efficiency = { costPerNewListingUsd: e1.n ? r4(e1.c / e1.n) : null, prevCostPerNewListingUsd: e0.n ? r4(e0.c / e0.n) : null, newListings: e1.n };

  const bySource = { apify: { costUsd: r4(runsUsd), runs: inCycle.length }, reddit: { costUsd: 0, runs: 0 }, phone: { costUsd: 0, runs: 0 } };
  for (const { r, t } of runs) if (r.source !== 'apify' && t >= cycle.start && t < cycle.end) { const b = bySource[r.source] ||= { costUsd: 0, runs: 0 }; b.runs++; }

  // Groups: per-group value over the cycle, joined to the watched list, plus recent daily spend and share.
  const watched = groupsView(s.groups);
  const gm = new Map(); for (const { r, v, t } of inCycle) addRunToGroups(gm, r, v, t);
  const gw = new Map(); for (const { r, v, t } of inCycle.filter(x => x.t >= winFrom)) addRunToGroups(gw, r, v, t);
  const total = [...gm.values()].reduce((a, g) => a + (g.costUsd || 0), 0);
  const groups = [...gm.values()].map(groupValue).map(g => {
    const w = watched.find(x => (x.name && x.name.toLowerCase() === g.group.toLowerCase()) || (g.url && x.url === g.url));
    return { ...g, url: g.url || w?.url || null, active: w ? w.active : null, cycleUsd: g.costUsd, dailyUsd: r4((gw.get(g.group)?.costUsd || 0) / Math.max(1, windowDays)), sharePct: total > 0 ? Math.round(1000 * g.costUsd / total) / 10 : 0 };
  }).sort((a, b) => (!a.postsFetched && a.failures) - (!b.postsFetched && b.failures) || b.cycleUsd - a.cycleUsd);

  // Cap hits: groups that returned the full per-group cap (report.truncated) in the last 7 days.
  const caps = new Map();
  for (const { v, t } of apify) if (t >= now - 7 * DAY && v.truncated) for (const g of v.truncated.groups || []) { const c = caps.get(g) || { group: g, runs: 0, cap: v.truncated.perGroup }; c.runs++; caps.set(g, c); }

  const recent = [...inCycle].sort((a, b) => b.t - a.t).slice(0, FINANCE.runsShown);
  const platform = median(recent.map(x => x.v.cost?.platformUsd).filter(x => typeof x === 'number' && x > 0));
  const platformPerRunUsd = platform != null ? r4(Math.max(platform, 0.00001)) : FINANCE.platformPerRunUsd;

  // What-if defaults: measured posts per group per hour over the last 7 days.
  const activeGroups = watched.filter(g => g.active && g.supported).length;
  const covered = firstRun == null ? 0 : Math.min(7 * DAY, now - Math.max(firstRun, now - 7 * DAY)) / HOUR;
  const posts7 = apify.filter(x => x.t >= now - 7 * DAY).reduce((a, x) => a + x.v.postsFetched, 0);
  const measured = configured && activeGroups > 0 && covered >= 24;
  const rowPriceUsd = rowPrice(actor);

  return {
    now, budget,
    apify: { configured, plan: (usage?.limitUsd ?? FINANCE.freePlanMaxUsd) <= FINANCE.freePlanMaxUsd ? 'free' : 'paid', actor, rowPriceUsd, platformPerRunUsd, usage: configured ? usage : null, usageError },
    cycle: { source: cycle.source, start: cycle.start, end: cycle.end, daysTotal: cycle.daysTotal, daysElapsed: cycle.daysElapsed, daysLeft: cycle.daysLeft, days: cycle.days },
    forecast, efficiency, perDay, bySource, groups,
    capHits: [...caps.values()].sort((a, b) => b.runs - a.runs),
    runs: recent.map(({ v }) => ({ ...v, cappedGroups: v.truncated?.groups || [] })),
    schedule: { enabled: sch.enabled, mode: sch.mode, runHoursIst: sch.runHoursIst, intervalHours: sch.intervalHours, ...gaps, resultsPerGroup: Math.min(MAX_RESULTS_PER_GROUP, Number(s.resultsPerGroup) || DEFAULT_RESULTS_PER_GROUP), maxRunUsd: sch.maxRunUsd, budgetWarnPct: sch.budgetWarnPct, budgetStopPct: sch.budgetStopPct, nextRunAt: configured ? nextRunAt(s, now) : null },
    whatIf: { activeGroups, postsPerGroupPerHour: measured ? r2(posts7 / (activeGroups * covered)) : FINANCE.fallbackPostsPerGroupHour, measured, rowPriceUsd, platformPerRunUsd },
    free: freeServices(env, s, now, sizeBytes),
  };
}
