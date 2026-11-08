// Group rotation, budget pacing and cohort planning (docs/ai/GROUP-SCHEDULING.md). Pure functions only:
// no I/O, no clock reads (callers pass `now`), so every rule is pinned by test/groupplan.test.js.
//
// Settings it reads (all optional):
//   groupPlan   admin policy (PLAN_DEFAULTS). enabled=false keeps today's single-run path untouched.
//   groupState  per group id (groupId(url)): status, why, at, since, lastRead, mode, lookbackH, coverage,
//               tier, rate, yield, per6h, echo, fails, manual, history (last 10 status changes).
// Rotation rules are deterministic (founder decision, 8 Nov 2026): no AI.
import { groupId, isPage, classifyFacebookUrl } from './groups.js';
import { groupKey, normUrl } from './core/logic.js';

const HOUR = 36e5, DAY = 24 * HOUR, IST = 5.5 * HOUR;
const r4 = x => Math.round(x * 10000) / 10000;
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Admin-tunable policy. Thresholds live here so they can be tuned without code changes. */
export const PLAN_DEFAULTS = {
  enabled: false,
  minActive: 6,        // keep at least this many groups being read (trial + active + sample)
  retryDays: 30,       // a group paused for low value / echo / failures may be re-tried in trial after this
  trialDays: 7,
  trialMaxUsd: 0.15,   // a trial ends early once it has cost this much
  minYield: 0.25,      // smoothed usable yield needed to pass a trial or stay active
  earlyMinYield: 0.10, // after 3 days and 20+ rows, a trial below this is paused early
  echoShare: 0.6,      // share of a group's rows that merged into listings first seen in another group
  sampleFloor: 0.15,   // smallest coverage worth paying for when not needed for minActive
  reservePct: 10,      // share of the daily allowance kept for trials
  failPause: 3,        // consecutive unscrapable runs before an automatic pause
  hotPer6h: 4,         // usable posts per 6 h: hot (read every slot)
  normalPer6h: 1.5,    //                         normal (every second slot); below: cold (2 a day)
};
/** Validation ranges for PUT /api/admin/group-plan: [min, max, integer?]. */
export const PLAN_LIMITS = {
  minActive: [1, 30, true], retryDays: [1, 365, true], trialDays: [1, 30, true], trialMaxUsd: [0.01, 2], minYield: [0, 1], earlyMinYield: [0, 1],
  echoShare: [0.1, 1], sampleFloor: [0.05, 1], reservePct: [0, 50, true], failPause: [1, 20, true], hotPer6h: [0.1, 100], normalPer6h: [0.1, 100],
};
/** Fixed constants (not admin-tunable). */
export const PLAN = {
  prior: 0.35, priorRows: 20,          // smoothed yield = (usable + 0.35 x 20) / (rows + 20)
  judgeRows: 20,                        // rows needed before an active group can be paused for low yield
  earlyDays: 3, earlyRows: 20,
  hysteresisMs: 7 * DAY,                // an active/sample group changes status at most once a week (failures excepted)
  ladder: [1, 2, 3, 6, 12],             // sample lookback hours: few distinct cutoffs, so few cohorts
  sampleReadsPerDay: 2, sampleHoursIst: [13, 21],
  trialLookbackH: 6,
  normalGapMs: 3.5 * HOUR,
  maxCohorts: 3, mergeWindowMs: HOUR,
  historyMax: 10,
  safety: 0.95,                         // spend at most 95 % of min(budget, Apify limit)
  runUsd: 0.0005,                       // platform cost of one actor run [est]
  fallbackRate: 1.5,                    // rows per hour assumed for a group with no data yet
  defaultBudgetUsd: 5,
};
// Why-codes that can be re-tried after the cool-off. 'manual' never is; 'budget' is re-ranked daily.
const RETRYABLE = new Set(['low yield', 'echo', 'unscrapable']);
const READING = new Set(['trial', 'active', 'sample']);
export const isReading = s => !!s && READING.has(s.status);

export const planOf = settings => ({ ...PLAN_DEFAULTS, ...obj(settings?.groupPlan) });
export const smoothYield = (usable, rows) => (usable + PLAN.prior * PLAN.priorRows) / (rows + PLAN.priorRows);
export function tierOf(per6h, plan = PLAN_DEFAULTS) {
  if (per6h == null) return 'normal';
  return per6h >= plan.hotPer6h ? 'hot' : per6h >= plan.normalPer6h ? 'normal' : 'cold';
}
/** Largest ladder lookback whose daily coverage (2 reads x L hours / 24) fits under c; at least the smallest step. */
export function lookbackFor(c) {
  let best = PLAN.ladder[0];
  for (const L of PLAN.ladder) if ((PLAN.sampleReadsPerDay * L) / 24 <= c + 1e-9) best = L;
  return best;
}
/** Budget in USD a month: settings.budget.monthlyUsd when valid (Finance page), else $5. */
export function budgetOf(settings) {
  const m = obj(settings?.budget).monthlyUsd;
  return typeof m === 'number' && m >= 0.5 && m <= 500 ? m : PLAN.defaultBudgetUsd;
}
const istDayStart = t => Math.floor((t + IST) / DAY) * DAY - IST;
function istMonthEnd(t) { const d = new Date(t + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - IST; }

/**
 * Daily allowance (design 4.4 step 1, replaces the 80 %/95 % halve-then-stop guard when the plan is on):
 *   cap  = min(budget, Apify limit) x 0.95
 *   A    = (cap - spent before today) / days left in the cycle counted from the start of today (IST)
 *   tick = min(A - spent today, cap - spent)   -> never above the day's allowance, never above the credit
 * usage: {usedUsd, limitUsd, cycleEnd}; spentTodayUsd: today's runs (actual cost, else their charge cap).
 */
export function dailyAllowance({ budgetUsd = PLAN.defaultBudgetUsd, usage = null, spentTodayUsd = 0, now }) {
  const limit = usage?.limitUsd > 0 ? usage.limitUsd : budgetUsd;
  const cap = Math.min(budgetUsd, limit) * PLAN.safety;
  let end = Date.parse(usage?.cycleEnd || '');
  if (!Number.isFinite(end)) end = istMonthEnd(now);
  let used = Number(usage?.usedUsd) || 0;
  // A cached reading from an earlier cycle says nothing about this one: the cycle rolled over, so start at 0.
  if (end <= now) { while (end <= now) { const d = new Date(end); d.setUTCMonth(d.getUTCMonth() + 1); end = d.getTime(); } used = 0; spentTodayUsd = 0; }
  const today = istDayStart(now);
  const spentToday = Math.max(0, Math.min(spentTodayUsd, used || spentTodayUsd));
  const before = Math.max(0, used - spentToday);
  const daysLeft = Math.max(1, (end - today) / DAY);
  const allowance = Math.max(0, (cap - before) / daysLeft);
  const tick = Math.max(0, Math.min(allowance - spentTodayUsd, cap - Math.max(used, spentTodayUsd)));
  return { capUsd: r4(cap), allowanceUsd: r4(allowance), spentTodayUsd: r4(spentTodayUsd), tickUsd: r4(tick), daysLeft: Math.round(daysLeft * 100) / 100, cycleEnd: end };
}

/** Watched groups the plan manages: enabled, with a link, not Facebook Pages. */
export const planGroups = settings => (Array.isArray(settings?.groups) ? settings.groups : [])
  .filter(g => g && g.url && g.active !== false && !isPage(g)).map(g => ({ id: groupId(g.url), name: g.name || '', url: g.url }));

/**
 * Resolve a group *name* as it appears in run reports (fetchedByGroup, newByGroup, crossFrom) to a watched
 * group id. Names come from the weekly group details or from our own settings.
 */
export function nameIndex(settings) {
  const all = (Array.isArray(settings?.groups) ? settings.groups : []).filter(g => g && g.url);
  const keys = new Map(); const urls = new Map();
  const add = (name, id) => { const k = groupKey(name || ''); if (k && !keys.has(k)) keys.set(k, id); };
  for (const g of all) { const id = groupId(g.url); urls.set(normUrl(g.url), id); add(g.name, id); }
  for (const r of obj(settings?.groupInfo).groups || []) {
    const id = urls.get(normUrl(r.url || '')) || (r.id && urls.get(normUrl('https://www.facebook.com/groups/' + r.id)));
    if (id) add(r.name, id);
  }
  const list = [...keys.entries()];
  const resolve = (name, url) => {
    if (url) { const c = classifyFacebookUrl(url); const id = c && urls.get(normUrl(c.url)); if (id) return id; }
    const k = groupKey(name || ''); if (!k) return null;
    if (keys.has(k)) return keys.get(k);
    if (k.length > 6) for (const [w, id] of list) if (w.length > 6 && (k.includes(w) || w.includes(k))) return id;
    return null;
  };
  return { resolve };
}

/**
 * Per-group numbers from ingested Apify runs, oldest first. rows: [{startedAt, costUsd, actor?, report:
 * {fetchedByGroup, newByGroup, crossFrom, unscrapable, caps}}]. Quality = smoothed usable yield (posts that
 * became new listings / rows) minus cross-posts; quantity = usable posts per 6 h of time actually read.
 * since: {gid: ms} counts trial numbers from that time.
 */
export function groupStats(rows, settings, { now, cycleStart = now - 30 * DAY, price = 0.0012, since = {}, failSince = {} } = {}) {
  const idx = nameIndex(settings);
  const watchedNow = planGroups(settings).map(g => g.id);
  const out = {};
  const S = id => (out[id] ||= { rows7: 0, usable7: 0, cross7: 0, crossBy: {}, coveredH7: 0, rowsCycle: 0, usableCycle: 0, usdCycle: 0, usd7: 0, fails: 0, lastSeenAt: null, trial: { rows: 0, usable: 0, usd: 0 } });
  const sorted = [...rows].filter(r => r && r.startedAt).sort((a, b) => a.startedAt - b.startedAt);
  let prev = null;
  for (const r of sorted) {
    const p = obj(r.report); const caps = obj(p.caps); const t = r.startedAt;
    const in7 = t >= now - 7 * DAY, inCycle = t >= cycleStart;
    const winH = Math.max(0, Math.min(24, (t - (Number(caps.after) || prev || t - 6 * HOUR)) / HOUR));
    prev = t;
    const fetched = {}, usable = {}, cross = {};
    for (const [g, n] of Object.entries(obj(p.fetchedByGroup))) { const id = idx.resolve(g); if (id) fetched[id] = (fetched[id] || 0) + (Number(n) || 0); }
    for (const [g, n] of Object.entries(obj(p.newByGroup))) { const id = idx.resolve(g); if (id) usable[id] = (usable[id] || 0) + (Number(n) || 0); }
    for (const [g, by] of Object.entries(obj(p.crossFrom))) {
      const id = idx.resolve(g); if (!id) continue;
      for (const [g2, n] of Object.entries(obj(by))) { const id2 = idx.resolve(g2); if (!id2 || id2 === id) continue; (cross[id] ||= {})[id2] = (cross[id]?.[id2] || 0) + (Number(n) || 0); }
    }
    const bad = new Set((Array.isArray(p.unscrapable) ? p.unscrapable : []).map(u => idx.resolve(u?.name, u?.url)).filter(Boolean));
    const covered = Array.isArray(caps.groupIds) ? caps.groupIds : watchedNow;
    for (const id of new Set([...covered, ...Object.keys(fetched), ...bad])) {
      const s = S(id); const n = fetched[id] || 0, u = usable[id] || 0;
      // Failures count only since the group's last status change, so a group re-tried after its cool-off is
      // not paused again for failures that happened before it was paused (QA round 3, issue 3).
      if (!(failSince[id] && t < failSince[id])) { if (bad.has(id)) s.fails++; else if (covered.includes(id) || n) s.fails = 0; }
      if (n) s.lastSeenAt = Math.max(s.lastSeenAt || 0, t);
      if (in7) {
        s.rows7 += n; s.usable7 += u; s.usd7 += n * price;
        if (covered.includes(id)) s.coveredH7 += winH;
        for (const [id2, c] of Object.entries(cross[id] || {})) { s.cross7 += c; s.crossBy[id2] = (s.crossBy[id2] || 0) + c; }
      }
      if (inCycle) { s.rowsCycle += n; s.usableCycle += u; s.usdCycle += n * price; }
      if (since[id] && t >= since[id]) { s.trial.rows += n; s.trial.usable += u; s.trial.usd += n * price; }
    }
  }
  for (const s of Object.values(out)) {
    s.coveredH7 = Math.min(7 * 24, s.coveredH7);
    s.rate = s.coveredH7 >= 1 ? s.rows7 / s.coveredH7 : null;               // rows per hour read
    s.yield = smoothYield(s.usable7, s.rows7);                                // smoothed usable yield
    s.rawYield = s.rows7 ? s.usable7 / s.rows7 : null;
    s.per6h = s.coveredH7 >= 1 ? (s.usable7 / s.coveredH7) * 6 : null;       // usable posts per 6 h
    s.crossShare = s.rows7 ? s.cross7 / s.rows7 : 0;
    s.echoOf = Object.entries(s.crossBy).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    s.usd7 = r4(s.usd7); s.usdCycle = r4(s.usdCycle); s.trial.usd = r4(s.trial.usd);
  }
  return out;
}

const EMPTY = { rows7: 0, usable7: 0, cross7: 0, crossBy: {}, coveredH7: 0, rate: null, yield: smoothYield(0, 0), rawYield: null, per6h: null, crossShare: 0, echoOf: null, fails: 0, trial: { rows: 0, usable: 0, usd: 0 } };
const fullCostPerDay = (s, price) => (s.rate ?? PLAN.fallbackRate) * 24 * price;
const trialCostPerDay = (s, plan, price) => Math.min(plan.trialMaxUsd / plan.trialDays, (s.rate ?? PLAN.fallbackRate) * PLAN.trialLookbackH * PLAN.sampleReadsPerDay * price);

/** Is g an echo (design 4.6)? Its cross-post share is high and the partner it echoes is the better group. */
export function echoOf(id, stats, state, plan = PLAN_DEFAULTS) {
  const s = stats[id] || EMPTY;
  if (!s.echoOf || s.rows7 < PLAN.judgeRows || s.crossShare < plan.echoShare) return null;
  const p = stats[s.echoOf]; const ps = state[s.echoOf];
  if (!p || (ps && !isReading(ps))) return null; // never pause both partners: only echo a group still being read
  // Symmetric tie-break: the partner with the higher yield stays; equal yield, the higher rate; then the id.
  const better = p.yield > s.yield || (p.yield === s.yield && ((p.rate || 0) > (s.rate || 0) || ((p.rate || 0) === (s.rate || 0) && s.echoOf < id)));
  return better ? { of: s.echoOf, share: Math.round(s.crossShare * 100) / 100 } : null;
}

function setStatus(s, status, why, now, events, id) {
  if (s.status === status && s.why === why) return s;
  const ev = { at: now, from: s.status || null, to: status, why };
  s.history = [...(Array.isArray(s.history) ? s.history : []), ev].slice(-PLAN.historyMax);
  s.status = status; s.why = why; s.at = now;
  if (status === 'trial') s.since = now;
  events.push({ id, ...ev });
  return s;
}

/**
 * The daily allocator (design 4.4-4.6 plus the founder rules of 8 Nov 2026). Returns the next groupState and
 * the status changes made. Order:
 *   1. new groups: judged at once on 7 days of data if there is enough, else queued in the pool;
 *   2. rotation: failures, trial verdicts, low yield, echo (manual choices are never overridden);
 *   3. pool -> trial: while fewer than minActive groups are read (new groups first, then groups whose
 *      cool-off has passed), and while the trial reserve or spare money allows;
 *   4. money: trials first, then groups ranked by value get full coverage, a partial sample, the sample
 *      floor or a budget pause; if that would leave fewer than minActive read, the best minActive share
 *      the money (water-filling) instead of anyone being paused, so spend never exceeds the allowance.
 */
export function allocate({ groups, state = {}, stats = {}, plan = PLAN_DEFAULTS, allowanceUsd, price = 0.0012, now }) {
  const events = []; const next = {};
  const A = Number.isFinite(allowanceUsd) ? Math.max(0, allowanceUsd) : Infinity;
  for (const g of groups) {
    const st = stats[g.id] || EMPTY;
    const s = next[g.id] = structuredClone(obj(state[g.id]));
    s.rate = st.rate == null ? null : r4(st.rate); s.yield = r4(st.yield); s.per6h = st.per6h == null ? null : Math.round(st.per6h * 100) / 100;
    s.crossShare = Math.round((st.crossShare || 0) * 100) / 100; s.fails = st.fails || 0;
    s.tier = tierOf(st.per6h, plan);
    if (!s.status) {
      if (st.rows7 >= PLAN.judgeRows) setStatus(s, st.yield >= plan.minYield ? 'active' : 'paused', st.yield >= plan.minYield ? 'judged on last 7 days' : 'low yield', now, events, g.id);
      else setStatus(s, 'paused', 'queued for trial', now, events, g.id);
    }
  }
  // 2. rotation
  const before = {}; // state before this pass, to undo a pause the minActive backstop takes back
  const keep = new Set(); // paused groups brought back early by the minActive backstop
  for (const g of groups) {
    const s = next[g.id]; const st = stats[g.id] || EMPTY;
    s.echo = echoOf(g.id, stats, next, plan);
    if (s.manual) continue;
    before[g.id] = structuredClone(s);
    if (isReading(s) && s.fails >= plan.failPause) { setStatus(s, 'paused', 'unscrapable', now, events, g.id); continue; }
    if (s.status === 'trial') {
      const age = now - (s.since || now); const t = st.trial;
      const raw = t.rows ? t.usable / t.rows : 1;
      if (age >= PLAN.earlyDays * DAY && t.rows >= PLAN.earlyRows && raw < plan.earlyMinYield) setStatus(s, 'paused', 'low yield', now, events, g.id);
      else if (age >= plan.trialDays * DAY || t.usd >= plan.trialMaxUsd) {
        if (s.echo) setStatus(s, 'paused', 'echo', now, events, g.id);
        else if (smoothYield(t.usable, t.rows) >= plan.minYield) setStatus(s, 'active', 'passed trial', now, events, g.id);
        else setStatus(s, 'paused', 'low yield', now, events, g.id);
      }
    } else if ((s.status === 'active' || s.status === 'sample') && now - (s.at || 0) >= PLAN.hysteresisMs) {
      if (s.echo) setStatus(s, 'paused', 'echo', now, events, g.id);
      else if (st.rows7 >= PLAN.judgeRows && st.yield < plan.minYield) setStatus(s, 'paused', 'low yield', now, events, g.id);
    }
  }
  // 3 + 4. pool, trials and money
  const ids = groups.map(g => g.id);
  const reading = () => ids.filter(id => isReading(next[id])).length;
  const trials = () => ids.filter(id => next[id].status === 'trial');
  const ranked = () => ids.filter(id => ['active', 'sample'].includes(next[id].status) || (next[id].status === 'paused' && next[id].why === 'budget' && !next[id].manual));
  const pool = ids.filter(id => { const s = next[id]; return s.status === 'paused' && !s.manual && (s.why === 'queued for trial' || (RETRYABLE.has(s.why) && now - (s.at || 0) >= plan.retryDays * DAY)); })
    .sort((a, b) => (next[a].why === 'queued for trial' ? 0 : 1) - (next[b].why === 'queued for trial' ? 0 : 1) || (next[a].at || 0) - (next[b].at || 0) || (a < b ? -1 : 1));
  const st = id => stats[id] || EMPTY;
  const trialUsd = () => trials().reduce((a, id) => a + trialCostPerDay(st(id), plan, price), 0);
  const rankedFull = () => ranked().reduce((a, id) => a + fullCostPerDay(st(id), price), 0);
  const reserve = A * plan.reservePct / 100;
  // Groups whose status is not 'budget' paused count towards minActive only once funded below; budget-paused
  // ones can be brought back by the water-fill, so they count as "available" here.
  const keptOrRankable = () => trials().length + ranked().length;
  for (const id of pool) {
    const cost = trialCostPerDay(st(id), plan, price);
    const spare = A - trialUsd() - rankedFull();
    const needed = keptOrRankable() < plan.minActive;
    if (needed || trialUsd() + cost <= Math.max(reserve, spare)) setStatus(next[id], 'trial', next[id].why === 'queued for trial' ? 'new group' : 'retry after cool-off', now, events, id);
  }
  // minActive backstop (QA round 3, issue 1): if the pool could not refill to minActive, keep the best paused
  // groups (by smoothed yield) that were paused for low yield or echo, before their cool-off. Never manual or
  // unscrapable ones. A group paused in this very pass is simply not paused (no history churn).
  if (keptOrRankable() < plan.minActive) {
    const back = ids.filter(id => { const s = next[id]; return s.status === 'paused' && !s.manual && (s.why === 'low yield' || s.why === 'echo'); })
      .sort((a, b) => st(b).yield - st(a).yield || (a < b ? -1 : 1));
    for (const id of back) {
      if (keptOrRankable() >= plan.minActive) break;
      const prev = before[id];
      if (prev && next[id].at === now && isReading(prev) && prev.status !== 'trial') {
        next[id] = prev;
        const i = events.findIndex(e => e.id === id && e.at === now && e.to === 'paused'); if (i >= 0) events.splice(i, 1);
      } else { keep.add(id); next[id].status = 'sample'; } // the status event is written once the money step decides full or sample
    }
  }
  // Money for ranked groups after trials.
  let left = Math.max(0, A - Math.max(trialUsd(), Math.min(reserve, A)));
  if (!Number.isFinite(A)) left = Infinity;
  const cands = ranked().sort((a, b) => (next[b].manual ? 1 : 0) - (next[a].manual ? 1 : 0) || st(b).yield - st(a).yield || (st(b).per6h || 0) - (st(a).per6h || 0) || (a < b ? -1 : 1));
  const cover = {};
  let money = left;
  for (const id of cands) {
    const full = fullCostPerDay(st(id), price);
    if (full <= money) { cover[id] = 1; money -= full; }
    else if (money > 0 && money / full >= plan.sampleFloor) { cover[id] = money / full; money = 0; }
    else cover[id] = 0;
  }
  const need = Math.max(0, plan.minActive - trials().length);
  const kept = cands.filter(id => cover[id] > 0).length;
  if (kept < Math.min(need, cands.length) && Number.isFinite(left)) {
    // Water-fill weighted by yield (QA round 3, issue 2): coverage c = k x yield, so a better group is never read
    // less than a weaker one; groups that reach full coverage drop out and the rest share what is left.
    let rest = cands.slice(0, Math.min(need, cands.length));
    for (const id of cands) cover[id] = 0;
    let rem = left;
    while (rest.length) {
      const k = rem / rest.reduce((a, id) => a + st(id).yield * fullCostPerDay(st(id), price), 0);
      const sat = rest.filter(id => k * st(id).yield >= 1);
      if (!sat.length) { for (const id of rest) cover[id] = k * st(id).yield; break; }
      for (const id of sat) { cover[id] = 1; rem -= fullCostPerDay(st(id), price); }
      rest = rest.filter(id => !sat.includes(id));
    }
  }
  for (const id of cands) {
    const s = next[id]; const c = cover[id] || 0;
    if (s.manual && s.status === 'active') { s.mode = c >= 0.999 ? 'full' : 'sample'; s.coverage = Math.round(Math.max(c, 1 / 12) * 100) / 100; s.lookbackH = s.mode === 'sample' ? lookbackFor(s.coverage) : null; continue; }
    if (keep.has(id)) {
      s.status = 'paused'; // keeps its pause reason; nothing changes if there is no money for it
      if (c > 0) { setStatus(s, c >= 0.999 ? 'active' : 'sample', 'kept to reach minimum', now, events, id); s.mode = c >= 0.999 ? 'full' : 'sample'; s.coverage = c >= 0.999 ? 1 : Math.floor(c * 100) / 100; s.lookbackH = c >= 0.999 ? null : lookbackFor(c); }
      else { s.mode = null; s.coverage = 0; s.lookbackH = null; }
      continue;
    }
    if (c <= 0) { setStatus(s, 'paused', 'budget', now, events, id); s.mode = null; s.coverage = 0; s.lookbackH = null; continue; }
    const full = c >= 0.999;
    if (s.status === 'paused') setStatus(s, full ? 'active' : 'sample', 'budget allows', now, events, id);
    else if (full && s.status === 'sample') setStatus(s, 'active', 'budget allows full', now, events, id);
    else if (!full && s.status === 'active') setStatus(s, 'sample', 'budget: sampled', now, events, id);
    s.mode = full ? 'full' : 'sample'; s.coverage = full ? 1 : Math.floor(c * 100) / 100; s.lookbackH = full ? null : lookbackFor(c);
  }
  for (const id of trials()) { const s = next[id]; s.mode = 'sample'; s.lookbackH = PLAN.trialLookbackH; s.coverage = Math.round(PLAN.sampleReadsPerDay * PLAN.trialLookbackH / 24 * 100) / 100; }
  for (const id of ids) { const s = next[id]; if (!isReading(s)) { s.mode = null; s.coverage = 0; s.lookbackH = null; } }
  const projectedUsd = projectedDailyUsd(next, stats, plan, price, ids);
  return { state: next, events, summary: { reading: reading(), minActive: plan.minActive, pool: ids.filter(id => next[id].status === 'paused' && !next[id].manual && next[id].why !== 'budget').length, projectedDailyUsd: r4(projectedUsd), allowanceUsd: Number.isFinite(A) ? r4(A) : null } };
}

/** Expected spend a day of the current plan: trials at their trial rate, the rest at full cost x coverage. */
export function projectedDailyUsd(state, stats, plan, price, ids) {
  return r4(ids.reduce((a, id) => {
    const s = state[id]; const st = stats[id] || EMPTY;
    if (s?.status === 'trial') return a + trialCostPerDay(st, plan, price);
    if (isReading(s)) return a + fullCostPerDay(st, price) * (s.coverage ?? 1);
    return a;
  }, 0));
}

/** Most recent sample read time (13:00 or 21:00 IST) at or before now. */
export function lastSampleTarget(now) {
  const day = istDayStart(now); let best = day - DAY + PLAN.sampleHoursIst.at(-1) * HOUR;
  for (const h of PLAN.sampleHoursIst) { const t = day + h * HOUR; if (t <= now) best = Math.max(best, t); }
  return best;
}
/** Is a reading group due this tick? hot every slot, normal every ~4 h, cold/sample/trial twice a day. */
export function isGroupDue(s, now) {
  if (!isReading(s)) return false;
  if (!s.lastRead || s.recoverNext) return true;
  if (s.status === 'active' && s.mode !== 'sample') {
    if (s.tier === 'hot') return true;
    if (s.tier === 'normal') return now - s.lastRead >= PLAN.normalGapMs;
  }
  return s.lastRead < lastSampleTarget(now);
}
/** Cutoff for one group (design 4.2). overlapMs: schedule overlap; floor: now - backfillDays. */
export function groupCutoff(s, now, { overlapMs, floor }) {
  if (!s.lastRead) return Math.max(floor, now - PLAN.trialLookbackH * HOUR);
  const base = s.lastRead - overlapMs;
  if (s.mode === 'sample' && !s.recoverNext) return Math.max(floor, base, now - (s.lookbackH || PLAN.trialLookbackH) * HOUR);
  return Math.max(floor, base);
}

/**
 * Cohorts for this tick (design 4.2): due groups grouped by cutoff, cutoffs within an hour merged to the
 * earliest, at most 3 cohorts (cohorts with hot groups, then the largest, first; the rest wait for the next
 * slot). Each cohort gets maxItems (per-group allowance: rate x window x 1.2, at least 5, at most the posts-
 * per-group cap) and maxCharge. If all cohorts together would cost more than tickUsd they are scaled down.
 */
export function planCohorts({ groups, state, now, overlapMs, floor, perGroup, price = 0.0012, tickUsd = Infinity, maxRunUsd = 0.5, infoFor = () => false }) {
  const due = groups.filter(g => isGroupDue(state[g.id], now)).map(g => ({ ...g, s: state[g.id], after: groupCutoff(state[g.id], now, { overlapMs, floor }) }));
  due.sort((a, b) => a.after - b.after || (a.id < b.id ? -1 : 1));
  const cohorts = [];
  for (const g of due) {
    const c = cohorts.at(-1);
    if (c && g.after - c.after <= PLAN.mergeWindowMs && !!g.s.recoverNext === c.recover) c.groups.push(g);
    else cohorts.push({ after: g.after, recover: !!g.s.recoverNext, groups: [g] });
  }
  const hot = c => c.groups.some(g => g.s.tier === 'hot' && g.s.mode !== 'sample');
  cohorts.sort((a, b) => Number(b.recover) - Number(a.recover) || Number(hot(b)) - Number(hot(a)) || b.groups.length - a.groups.length || a.after - b.after);
  const chosen = cohorts.slice(0, PLAN.maxCohorts);
  const waiting = cohorts.slice(PLAN.maxCohorts).reduce((a, c) => a + c.groups.length, 0);
  const out = chosen.map(c => {
    const pg = c.recover ? 50 : perGroup;
    const winH = Math.max(0.5, (now - c.after) / HOUR);
    const info = !!infoFor(c.groups);
    const items = c.groups.reduce((a, g) => a + Math.min(pg, Math.max(5, Math.ceil((g.s.rate ?? PLAN.fallbackRate) * winH * 1.2))), 0) + (info ? c.groups.length : 0);
    const maxItems = Math.min(items, c.groups.length * pg + (info ? c.groups.length : 0));
    const maxCharge = Math.max(0.01, Math.min(maxRunUsd, Math.ceil(maxItems * price * 1.2 * 10000) / 10000));
    return { groupIds: c.groups.map(g => g.id), urls: c.groups.map(g => g.url), after: c.after, recover: c.recover, perGroup: pg, groupInfo: info, maxItems, maxCharge };
  });
  const total = out.reduce((a, c) => a + c.maxCharge + PLAN.runUsd, 0);
  if (total > tickUsd) {
    const k = Math.max(0, tickUsd - out.length * PLAN.runUsd) / Math.max(1e-9, total - out.length * PLAN.runUsd);
    for (const c of out) { c.maxCharge = Math.floor(c.maxCharge * k * 10000) / 10000; c.maxItems = Math.min(c.maxItems, Math.floor(c.maxCharge / (price * 1.2))); c.scaled = true; }
  }
  return { cohorts: out.filter(c => c.maxItems >= 1 && c.maxCharge > 0), waiting, due: due.length };
}

/** Manual admin action on one group. Returns the patch for that group (never overridden by the allocator). */
export function manualAction(s0, action, now) {
  const s = structuredClone(obj(s0)); const events = [];
  if (action === 'pause') { setStatus(s, 'paused', 'manual', now, events, ''); s.manual = true; s.mode = null; s.coverage = 0; }
  else if (action === 'promote') { setStatus(s, 'active', 'manual', now, events, ''); s.manual = true; s.mode = s.mode || 'full'; s.coverage = s.coverage || 1; }
  else if (action === 'resume') { s.manual = false; setStatus(s, 'trial', 'resumed by admin', now, events, ''); s.mode = 'sample'; s.lookbackH = PLAN.trialLookbackH; }
  else return null;
  return s;
}
