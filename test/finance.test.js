// Admin "Finance & budget" (docs/design/FINANCE.md): forecast maths, status table, what-if, suggestion
// rules, the GET /api/admin/finance shape (with and without Apify), budget PUT validation and D1 query count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRepo } from '../src/db/repo.js';
import { getUsage } from '../src/apify.js';
import { forecastOf, cycleOf, scheduleGaps, validateBudget, financeView } from '../src/finance.js';
import { whatIfCost, suggestions, verdict, niceMoney, moneyTick, costDelta, fdate } from '../web/finance.js';
import { memoryDb } from './helpers.js';

const BASE = 'https://hunt.test';
const DAY = 864e5;
const r2 = x => Math.round(x * 100) / 100;

function counting(t) {
  let n = 0;
  const c = { ...t.db, all: (...a) => (n++, t.db.all(...a)), first: (...a) => (n++, t.db.first(...a)), run: (...a) => (n++, t.db.run(...a)), batch: l => (n += l.length, t.db.batch(l)) };
  return { repo: createRepo(c), count: () => n, reset: () => { n = 0; } };
}
async function harness(envOver = {}, { usage, usageStatus = 200 } = {}) {
  const t = await memoryDb(); const c = counting(t);
  const calls = [];
  const fetchFn = async url => {
    const u = new URL(url); calls.push(u.pathname);
    if (u.pathname === '/v2/users/me/limits') return usageStatus === 200 ? Response.json({ data: usage }) : new Response('{}', { status: usageStatus });
    return new Response('nf', { status: 404 });
  };
  const app = createApp({ repo: () => c.repo, assets: async () => null, fetch: fetchFn });
  const env = { RUNTIME: 'node', AUTH_DISABLED: '1', ...envOver };
  const call = async (method, path, body) => {
    const res = await app.fetch(new Request(BASE + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { ...t, c, call, calls, env, fetchFn };
}
async function addRun(db, { source = 'apify', ds, startedAt, costUsd = null, report = {}, status = 'done' }) {
  await db.run(`INSERT INTO runs (source, dataset_id, run_id, status, started_at, at, report, actor, cost_usd, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [source, ds, 'run-' + ds, status, startedAt, startedAt, JSON.stringify(report), source === 'apify' ? 'automly~facebook-public-group-posts-scraper' : null, costUsd, startedAt + 60e3]);
}

// ---------- pure maths ----------
test('forecast: the spec worked example, capped by the Apify stop guard (pause 23 Nov, spend stops at $4.75)', () => {
  const start = Date.parse('2026-11-01T00:00:00Z'), end = Date.parse('2026-12-01T00:00:00Z'), now = start + 7.5 * DAY;
  const cycle = cycleOf({ cycleStart: '2026-11-01T00:00:00.000Z', cycleEnd: '2026-12-01T00:00:00.000Z', usedUsd: 1.86, limitUsd: 5 }, now);
  assert.equal(cycle.source, 'apify'); assert.equal(cycle.daysTotal, 30); assert.equal(cycle.daysElapsed, 7.5); assert.equal(cycle.daysLeft, 22.5); assert.equal(cycle.days.length, 30);
  assert.equal(cycle.start, start); assert.equal(cycle.end, end);
  const f = forecastOf({ now, cycle, budget: 5, mtd: 1.86, rate: 0.19, rateWindowDays: 7, hasRuns: true, usage: { usedUsd: 1.86, limitUsd: 5, ratio: 0.372 } });
  // The spec's $6.14 is impossible: the guard stops runs at 95% of the $5 credit, so spend stops near $4.75.
  assert.equal(f.uncappedProjectedUsd, 6.14); assert.equal(f.projectedUsd, 4.75); assert.equal(f.projectionCapped, true);
  assert.equal(f.status, 'watch'); assert.equal(f.reason, 'pause');
  assert.equal(fdate(f.warnAt), '19 Nov'); assert.equal(fdate(f.pauseAt), '23 Nov');
  assert.equal(f.budgetAt, null, 'the pause comes before the budget could be crossed');
  assert.equal(f.paused, false);
  // A budget below the stop level is crossed first: then budgetAt is set and the reason is the projection.
  const low = forecastOf({ now, cycle, budget: 3, mtd: 1.86, rate: 0.19, rateWindowDays: 7, hasRuns: true, usage: { usedUsd: 1.86, limitUsd: 5, ratio: 0.372 } });
  assert.equal(low.reason, 'projection'); assert.ok(Math.abs((low.budgetAt - now) / DAY - (3 - 1.86) / 0.19) < 1e-6); assert.equal(low.projectedUsd, 4.75);
  // A paid plan with room: no cap, the budget-cross date is real.
  const paid = forecastOf({ now, cycle, budget: 5, mtd: 1.86, rate: 0.19, rateWindowDays: 7, hasRuns: true, usage: { usedUsd: 1.86, limitUsd: 20, ratio: 0.093 } });
  assert.deepEqual([paid.projectedUsd, paid.projectionCapped, paid.reason, paid.pauseAt], [6.14, false, 'projection', null]);
});

test('forecast: once the guard has paused scraping nothing more is spent (QA: $4.90 of $5, stop 95%)', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const cycle = cycleOf({ cycleStart: '2026-11-01T00:00:00Z', cycleEnd: '2026-12-01T00:00:00Z' }, now);
  const f = forecastOf({ now, cycle, budget: 5, mtd: 4.9, rate: 0.3, rateWindowDays: 7, hasRuns: true, usage: { usedUsd: 4.9, limitUsd: 5, ratio: 0.98 } });
  assert.deepEqual([f.paused, f.forwardRateUsd, f.projectedUsd, f.budgetAt, f.pauseAt, f.status, f.reason], [true, 0, 4.9, null, null, 'watch', 'paused']);
  // Same comparison as the guard (ratio > stop%): exactly at the stop level is not paused yet.
  const edge = forecastOf({ now, cycle, budget: 5, mtd: 4.75, rate: 0.3, rateWindowDays: 7, hasRuns: true, usage: { usedUsd: 4.75, limitUsd: 5, ratio: 0.95 } });
  assert.equal(edge.paused, false); assert.equal(edge.projectedUsd, 4.75); assert.equal(edge.pauseAt, now);
  const F = { now, budget: { monthlyUsd: 5 }, apify: { configured: true, plan: 'free', usage: { usedUsd: 4.9, limitUsd: 5, ratio: 0.98, checkedAt: now }, usageError: null },
    cycle: { ...cycle }, forecast: f, perDay: [{ runs: 3 }], groups: [{ group: 'G', active: true, dailyUsd: 0.2, listingsPerUsd: 10, lowValue: false }], capHits: [], free: [],
    schedule: { enabled: true, budgetStopPct: 95, budgetWarnPct: 80, resultsPerGroup: 30, runsPerDay: 8, longestGapHours: 9, longestGap: 'x' }, whatIf: { activeGroups: 1, postsPerGroupPerHour: 1, rowPriceUsd: 0.0012, platformPerRunUsd: 0.00015 } };
  const v = verdict(F);
  assert.ok(v.html.startsWith('<strong>Scraping paused.</strong> Apify credit is 98% used ($4.90 of $5.00), past the 95% stop level, so no runs start until 1 Dec.'), v.html);
  assert.doesNotMatch(v.html, /reach about/);
  const S = suggestions(F).map(x => x.id);
  assert.ok(S.includes('R10')); assert.ok(!S.includes('R2'), 'no budget-cross date that cannot happen');
});

test('forecast: status table (spec 8.2): over and watch are never hidden by thin data', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const cycle = cycleOf({ cycleStart: '2026-11-01T00:00:00Z', cycleEnd: '2026-12-01T00:00:00Z' }, now);
  const base = { now, cycle, budget: 5, rateWindowDays: 7, hasRuns: true };
  const u = (used, limit = 5) => ({ usedUsd: used, limitUsd: limit, ratio: used / limit });
  assert.equal(forecastOf({ ...base, mtd: 1, rate: 0.1, usage: u(1) }).status, 'ok');
  assert.deepEqual([forecastOf({ ...base, mtd: 5.2, rate: 0, usage: u(5.2, 10) }).status, forecastOf({ ...base, mtd: 5.2, rate: 0, usage: u(5.2, 10) }).reason], ['over', 'budget']);
  const credit = forecastOf({ ...base, budget: 20, mtd: 5, rate: 0, usage: u(5) });
  assert.deepEqual([credit.status, credit.reason, credit.paused], ['over', 'credit', true]);
  const warn = forecastOf({ ...base, budget: 20, mtd: 4.1, rate: 0, usage: u(4.1) });
  assert.deepEqual([warn.status, warn.reason], ['watch', 'warn']);
  assert.equal(forecastOf({ ...base, mtd: 0, rate: 0, hasRuns: false }).status, 'unknown', 'no runs');
  assert.equal(forecastOf({ ...base, mtd: 0.02, rate: 0.02, rateWindowDays: 0.3 }).status, 'unknown', 'under one day of data');
  assert.equal(forecastOf({ ...base, mtd: 0.5, rate: 2, rateWindowDays: 0.3 }).status, 'watch', 'projection over budget wins over thin data');
  const off = forecastOf({ ...base, mtd: 1, rate: 0.5, usage: u(1), enabled: false });
  assert.deepEqual([off.projectedUsd, off.pauseAt, off.warnAt, off.status], [1, null, null, 'ok'], 'scraping off: nothing more is spent');
  const zero = forecastOf({ ...base, mtd: 1, rate: 0, usage: u(1) });
  assert.deepEqual([zero.projectedUsd, zero.pauseAt], [1, null]);
});

test('cycle: calendar IST month when Apify was never read; a stale reading rolls forward', () => {
  const now = Date.parse('2026-11-08T06:00:00Z');
  const cal = cycleOf(null, now);
  assert.equal(cal.source, 'calendar'); assert.equal(cal.days[0], '2026-11-01'); assert.equal(cal.days.at(-1), '2026-11-30'); assert.equal(cal.current, false);
  const rolled = cycleOf({ cycleStart: '2026-09-20T00:00:00Z', cycleEnd: '2026-10-20T00:00:00Z' }, now);
  assert.equal(new Date(rolled.start).toISOString().slice(0, 10), '2026-10-20'); assert.equal(new Date(rolled.end).toISOString().slice(0, 10), '2026-11-20');
  assert.equal(rolled.current, false, 'last cycle\'s usedUsd is not this cycle\'s spend');
});

test('schedule gaps wrap around midnight', () => {
  assert.deepEqual(scheduleGaps({ mode: 'times', runHoursIst: [6, 9, 11, 13, 15, 17, 19, 21] }), { runsPerDay: 8, longestGapHours: 9, longestGap: '9 PM to 6 AM, 9 h' });
  assert.deepEqual(scheduleGaps({ mode: 'times', runHoursIst: [23, 1] }), { runsPerDay: 2, longestGapHours: 22, longestGap: '1 AM to 11 PM, 22 h' });
  assert.deepEqual(scheduleGaps({ mode: 'interval', intervalHours: 6, runHoursIst: [6] }), { runsPerDay: 4, longestGapHours: 6, longestGap: 'every 6 h' });
});

test('what-if: the spec worked example ($5.84 a month, 3 groups in budget, 15 posts per run)', () => {
  const c = whatIfCost({ groups: 4, pph: 1.65, price: 0.0012, runsPerDay: 8, platformPerRunUsd: 0.00015, budget: 5, limitUsd: 5, stopPct: 95, longestGapHours: 9 });
  assert.deepEqual([r2(c.postsUsd), r2(c.detailsUsd), r2(c.platformUsd), r2(c.monthlyUsd), r2(c.perGroupUsd)], [5.78, 0.02, 0.04, 5.84, 1.45]);
  assert.equal(c.maxGroups, 3); assert.equal(c.maxFree, 3); assert.equal(c.postsPerRun, 15);
  assert.equal(r2(c.monthlyAt(4)), 5.84);
});

test('formatting helpers: money axis, ticks, cost delta colours', () => {
  assert.equal(niceMoney(0.31), 0.4); assert.equal(niceMoney(6.45), 8); assert.equal(niceMoney(5.25), 8); assert.equal(niceMoney(0.5), 0.8);
  // Every one of the 4 equal steps is a whole number of cents, so labels are exact.
  for (const v of [0.01, 0.07, 0.31, 0.5, 0.99, 1.3, 4.2, 6.45, 13, 47, 260]) { const m = niceMoney(v); assert.ok(m >= v, `${m} >= ${v}`); assert.ok(Number.isInteger(Math.round(m * 100 * 1e6) / 1e6 / 4), `${v} -> ${m}`); }
  assert.equal(moneyTick(2.5), '$2.50'); assert.equal(moneyTick(5), '$5');
  assert.match(costDelta(0.0084, 0.0102), /class="up">18% cheaper/);
  assert.match(costDelta(0.012, 0.01), /class="warn-t">\+20% dearer/);
  assert.equal(costDelta(0.01, null), 'no earlier data');
});

// ---------- suggestions ----------
function fixture(over = {}) {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const F = {
    now, budget: { monthlyUsd: 5 },
    apify: { configured: true, plan: 'paid', actor: 'automly~facebook-public-group-posts-scraper', usage: { usedUsd: 1.86, limitUsd: 20, ratio: 0.093, checkedAt: now - 12 * 60e3 }, usageError: null },
    cycle: { start: Date.parse('2026-11-01T00:00:00Z'), end: Date.parse('2026-12-01T00:00:00Z'), daysTotal: 30, daysElapsed: 7.5, daysLeft: 22.5, source: 'apify', days: [] },
    forecast: { mtdUsd: 1.86, mtdSource: 'apify', dailyRateUsd: 0.19, forwardRateUsd: 0.19, rateWindowDays: 7, projectedUsd: 6.14, uncappedProjectedUsd: 6.14, projectionCapped: false, status: 'watch', reason: 'projection', limitUsd: 20, creditUsedUsd: 1.86, pauseAt: null, budgetAt: now + ((5 - 1.86) / 0.19) * DAY },
    perDay: [{ day: '2026-11-01', runs: 8, costUsd: 0.3 }],
    groups: [
      { group: 'Bangalore Flat & Flatmates', active: true, cycleUsd: 0.48, dailyUsd: 0.054, listingsPerUsd: 46, newListings: 22, yieldPct: 5.5, lowValue: true },
      { group: 'Bellandur Flats', active: true, cycleUsd: 0.62, dailyUsd: 0.07, listingsPerUsd: 140, newListings: 87, yieldPct: 25, lowValue: false },
    ],
    capHits: [], free: [],
    schedule: { enabled: true, runsPerDay: 8, longestGapHours: 9, longestGap: '9 PM to 6 AM, 9 h', resultsPerGroup: 30, budgetWarnPct: 80, budgetStopPct: 95 },
    whatIf: { activeGroups: 4, postsPerGroupPerHour: 1.65, measured: true, rowPriceUsd: 0.0012, platformPerRunUsd: 0.00015 },
  };
  return { ...F, ...over };
}
test('suggestions: R2 names the fewest low-value groups that bring the cycle inside budget (spec example $4.92)', () => {
  const S = suggestions(fixture());
  assert.equal(S[0].id, 'R2');
  assert.match(S[0].html, /Pausing "Bangalore Flat &amp; Flatmates" would bring the cycle to about \$4\.92\./);
  assert.ok(Math.abs(S[0].savingUsd - 1.215) < 0.006, String(S[0].savingUsd));
  assert.equal(S[0].action.href, '#admin-groups');
  assert.ok(!S.some(s => s.id === 'R3'), 'a group named in R2 is not repeated as R3');
});
test('suggestions: over budget, cap hits, budget above the free plan, stale usage, free allowance, max 4 sorted by severity', () => {
  const F = fixture({ budget: { monthlyUsd: 1.5 }, forecast: { ...fixture().forecast, status: 'over', reason: 'budget' },
    capHits: [{ group: 'HSR Layout Rentals', runs: 2, cap: 30 }], free: [{ id: 'workers_ai', name: 'Workers AI', measured: true, used: 9000, limit: 10000, unit: 'neurons', period: 'day' }] });
  const S = suggestions(F);
  assert.equal(S.length, 4); assert.equal(S[0].id, 'R1'); assert.equal(S[0].severity, 'over');
  assert.ok(S.every((s, i) => i === 0 || ['over', 'watch', 'tip'].indexOf(s.severity) >= ['over', 'watch', 'tip'].indexOf(S[i - 1].severity)));
  const all = suggestions({ ...F, groups: [] });
  assert.ok(all.some(s => s.id === 'R4' && /1 group hit the 30-post cap .*"HSR Layout Rentals".*9 PM to 6 AM, 9 h/.test(s.html)));
  assert.ok(all.some(s => s.id === 'R7' && /Workers AI used 90% of its free daily allowance/.test(s.html) && s.action.href === '#admin-ai'));
  const paid = suggestions(fixture({ budget: { monthlyUsd: 20 }, forecast: { ...fixture().forecast, projectedUsd: 3, status: 'ok', reason: null, budgetAt: null }, groups: [], apify: { ...fixture().apify, plan: 'free', usage: { ...fixture().apify.usage, limitUsd: 5, checkedAt: Date.parse('2026-11-07T12:00:00Z') } } }));
  assert.ok(paid.some(s => s.id === 'R5'), 'budget above the $5 free plan');
  assert.ok(paid.some(s => s.id === 'R8' && /last read 1 day ago/.test(s.html)), 'usage older than 6 h');
  const room = suggestions(fixture({ forecast: { ...fixture().forecast, projectedUsd: 1.2, status: 'ok', reason: null, budgetAt: null }, groups: [] }));
  const r6 = room.find(s => s.id === 'R6'); assert.ok(r6); assert.equal(r6.action.k, 2); assert.match(r6.html, /room for about 2 more groups/);
  assert.deepEqual(suggestions(fixture({ apify: { configured: false } })).map(s => s.id), ['R0']);
});
test('verdict copy follows the status and always starts with the status word', () => {
  const F = fixture();
  assert.match(verdict(F).html, /^<strong>On track to go over\.<\/strong> \$1\.86 spent of your \$5\.00 budget\. At \$0\.19 a day you'll pass it around 25 Nov and reach about \$6\.14 by 1 Dec\./);
  const pause = fixture({ apify: { ...F.apify, plan: 'free', usage: { ...F.apify.usage, limitUsd: 5, ratio: 0.372 } }, forecast: { ...F.forecast, reason: 'pause', projectedUsd: 4.75, projectionCapped: true, limitUsd: 5, budgetAt: null, pauseAt: Date.parse('2026-11-23T17:00:00Z') } });
  assert.match(verdict(pause).html, /^<strong>Scraping will pause\.<\/strong> .*reaches the 95% stop level on 23 Nov, and runs pause until 1 Dec\. Spending stops near \$4\.75\./);
  const r9 = suggestions(pause).find(x => x.id === 'R9');
  assert.ok(r9 && /pauses for about 7 days until 1 Dec/.test(r9.html), 'R9 explains the pause instead of an impossible total');
  assert.ok(!suggestions(pause).some(x => x.id === 'R2'));
  assert.match(verdict(fixture({ apify: { configured: false } })).html, /^Nothing is being spent/);
  const err = verdict(fixture({ apify: { ...F.apify, usage: null, usageError: 'HTTP 500 <x>' } }));
  assert.match(err.sub, /\(HTTP 500 &lt;x&gt;\)/, 'server text is escaped');
});

// ---------- endpoint ----------
test('GET /api/admin/finance: combined shape, forecast from Apify usage, groups, cap hits, few D1 queries', async () => {
  const now = Date.now();
  const usage = { current: { monthlyUsageUsd: 0.16 }, limits: { maxMonthlyUsageUsd: 5 }, monthlyUsageCycle: { startAt: new Date(now - 10 * DAY).toISOString(), endAt: new Date(now + 20 * DAY).toISOString() } };
  const h = await harness({ APIFY_TOKEN: 'apify_api_X' }, { usage });
  await h.repo.putSettings({ groups: [{ name: 'G1', url: 'https://www.facebook.com/groups/111', active: true }, { name: 'G2', url: 'https://www.facebook.com/groups/222', active: false }] });
  const rep = extra => ({ total: 40, newListings: 5, fetchedByGroup: { G1: 30, G2: 10 }, newByGroup: { G1: 4, G2: 1 }, cost: { totalUsd: 0.05, platformUsd: 0.0002, resultsUsd: 0.0498, rows: 40 }, ...extra });
  await addRun(h.db, { ds: 'dsAAAAAA1', startedAt: now - 3 * DAY, costUsd: 0.05, report: rep({ truncated: { groups: ['G1'], rows: false, charge: false, perGroup: 30, after: now - 4 * DAY, recover: false } }) });
  await addRun(h.db, { ds: 'dsAAAAAA2', startedAt: now - 2 * DAY, costUsd: 0.05, report: rep() });
  await addRun(h.db, { ds: 'dsAAAAAA3', startedAt: now - 1 * DAY, costUsd: 0.05, report: rep() });
  await addRun(h.db, { source: 'reddit', ds: 'reddit-1', startedAt: now - DAY, report: { total: 12, newListings: 3 } });

  // The view itself: settings + runs + database size + one settings write for the fresh usage reading.
  h.c.reset();
  await financeView(h.c.repo, h.env, h.fetchFn, { refresh: true });
  assert.ok(h.c.count() <= 4, `financeView used ${h.c.count()} D1 statements`);
  // The whole request, auth included, stays far below the Workers Free cap of 50.
  h.c.reset();
  const r = await h.call('GET', '/api/admin/finance?refresh=1');
  assert.equal(r.status, 200);
  assert.ok(h.c.count() <= 10, `finance GET used ${h.c.count()} D1 statements`);
  const F = r.data;
  for (const k of ['now', 'budget', 'apify', 'cycle', 'forecast', 'efficiency', 'perDay', 'bySource', 'groups', 'capHits', 'runs', 'schedule', 'whatIf', 'free']) assert.ok(k in F, k);
  assert.deepEqual(F.budget, { monthlyUsd: 5, updatedAt: null });
  assert.equal(F.apify.configured, true); assert.equal(F.apify.plan, 'free'); assert.equal(F.apify.rowPriceUsd, 0.0012); assert.equal(F.apify.platformPerRunUsd, 0.0002);
  assert.equal(F.apify.usage.usedUsd, 0.16); assert.ok(F.apify.usage.cycleStart, 'getUsage returns cycleStart'); assert.ok(F.apify.usage.checkedAt);
  assert.equal(F.cycle.source, 'apify'); assert.equal(F.cycle.daysTotal, 30);
  assert.equal(F.forecast.mtdSource, 'apify'); assert.equal(F.forecast.mtdUsd, 0.16); assert.equal(F.forecast.runsUsd, 0.15);
  assert.ok(Math.abs(F.forecast.rateWindowDays - 3) < 0.01, 'window = days since our first run when shorter than 7');
  assert.ok(Math.abs(F.forecast.dailyRateUsd - 0.05) < 0.001);
  assert.ok(Math.abs(F.forecast.projectedUsd - (0.16 + 0.05 * F.cycle.daysLeft)) < 0.01);
  assert.equal(F.forecast.status, 'ok');
  assert.equal(r2(F.perDay.reduce((a, d) => a + d.costUsd, 0)), 0.15); assert.equal(F.perDay.reduce((a, d) => a + d.runs, 0), 3);
  assert.deepEqual(F.bySource, { apify: { costUsd: 0.15, runs: 3 }, reddit: { costUsd: 0, runs: 1 }, phone: { costUsd: 0, runs: 0 } });
  assert.equal(F.groups[0].group, 'G1'); assert.equal(F.groups[0].cycleUsd, 0.108); assert.equal(F.groups[0].sharePct, 75); assert.equal(F.groups[0].active, true);
  assert.equal(F.groups[1].active, false, 'joined to the watched list');
  assert.ok(F.groups[0].dailyUsd > 0);
  assert.deepEqual(F.capHits, [{ group: 'G1', runs: 1, cap: 30 }]);
  assert.equal(F.runs.length, 3); assert.ok(F.runs[0].startedAt > F.runs[2].startedAt, 'newest first');
  assert.deepEqual(F.runs[2].cappedGroups, ['G1']); assert.deepEqual(F.runs[0].cappedGroups, []);
  assert.equal(F.efficiency.newListings, 15); assert.equal(F.efficiency.costPerNewListingUsd, 0.01);
  assert.deepEqual([F.schedule.runsPerDay, F.schedule.longestGapHours, F.schedule.resultsPerGroup], [8, 9, 30]);
  assert.equal(F.whatIf.activeGroups, 1); assert.equal(F.whatIf.measured, true);
  assert.equal(F.whatIf.postsPerGroupPerHour, r2(120 / 72));
  assert.deepEqual(F.free.map(s => s.id), ['workers', 'd1', 'workers_ai', 'github', 'reddit']);
  assert.equal(F.free.find(s => s.id === 'workers').measured, false);
  const d1 = F.free.find(s => s.id === 'd1'); assert.equal(d1.measured, true); assert.ok(d1.used > 0, 'database size measured');

  // A second load within 10 minutes uses the cached usage (no Apify call); ?refresh=1 forces one.
  const before = h.calls.length; h.c.reset();
  await financeView(h.c.repo, h.env, h.fetchFn);
  assert.equal(h.calls.length, before); assert.ok(h.c.count() <= 3, `cached view used ${h.c.count()}`);
  await h.call('GET', '/api/admin/finance?refresh=1');
  assert.equal(h.calls.length, before + 1);
});

test('GET /api/admin/finance: empty state without APIFY_TOKEN and without runs', async () => {
  const h = await harness();
  const r = await h.call('GET', '/api/admin/finance');
  assert.equal(r.status, 200);
  const F = r.data;
  assert.equal(F.apify.configured, false); assert.equal(F.apify.usage, null); assert.equal(F.apify.usageError, null);
  assert.equal(F.cycle.source, 'calendar');
  assert.deepEqual([F.forecast.mtdUsd, F.forecast.projectedUsd, F.forecast.status], [0, 0, 'unknown']);
  assert.deepEqual([F.groups, F.runs, F.capHits], [[], [], []]);
  assert.ok(F.perDay.length >= 1 && F.perDay.every(d => d.runs === 0 && d.costUsd === 0));
  assert.equal(F.whatIf.measured, false); assert.equal(F.whatIf.postsPerGroupPerHour, 1.5); assert.equal(F.whatIf.rowPriceUsd, 0.0012);
  assert.equal(F.schedule.nextRunAt, null);
  assert.equal(F.free.find(s => s.id === 'reddit').connected, false);
  assert.equal(h.calls.length, 0, 'no Apify call without a token');
});

test('GET /api/admin/finance: a failed usage read keeps the cached reading and reports usageError (still 200)', async () => {
  const h = await harness({ APIFY_TOKEN: 'apify_api_X' }, { usageStatus: 500 });
  const cached = { usedUsd: 1.2, limitUsd: 5, ratio: 0.24, cycleEnd: new Date(Date.now() + 5 * DAY).toISOString(), checkedAt: Date.now() - 3 * 36e5 };
  await h.repo.putSettings({ apifyUsage: cached });
  const r = await h.call('GET', '/api/admin/finance?refresh=1');
  assert.equal(r.status, 200);
  assert.match(r.data.apify.usageError, /HTTP 500/);
  assert.equal(r.data.apify.usage.usedUsd, 1.2); assert.equal(r.data.forecast.mtdSource, 'apify');
  assert.equal((await h.repo.getSettings()).apifyUsage.checkedAt, cached.checkedAt, 'cache untouched');
});

test('PUT /api/admin/finance: budget from $0.50 to $500, rounded to cents', async () => {
  const h = await harness();
  for (const bad of [0.4, 501, -1, 'abc', '', null, true, undefined, [5], '0x10', '1e2', ' -5', '12.345', 'Infinity', NaN]) {
    const r = await h.call('PUT', '/api/admin/finance', { monthlyBudgetUsd: bad });
    assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`); assert.equal(r.data.error, 'bad_budget'); assert.match(r.data.message, /\$0\.50 to \$500/);
  }
  const ok = await h.call('PUT', '/api/admin/finance', { monthlyBudgetUsd: 12.345 });
  assert.equal(ok.status, 200); assert.equal(ok.data.budget.monthlyUsd, 12.35); assert.ok(ok.data.budget.updatedAt);
  assert.equal((await h.call('GET', '/api/admin/finance')).data.budget.monthlyUsd, 12.35);
  assert.equal(validateBudget('0.5'), 0.5); assert.equal(validateBudget('12.50'), 12.5); assert.equal(validateBudget(500), 500);
  // A malformed stored budget falls back to the default.
  await h.repo.putSettings({ budget: { monthlyUsd: 'lots' } });
  assert.deepEqual((await h.call('GET', '/api/admin/finance')).data.budget, { monthlyUsd: 5, updatedAt: null });
});

test('getUsage returns the cycle start as well as the end', async () => {
  const fetchFn = async () => Response.json({ data: { current: { monthlyUsageUsd: 1.234 }, limits: { maxMonthlyUsageUsd: 5 }, monthlyUsageCycle: { startAt: '2026-11-01T00:00:00.000Z', endAt: '2026-12-01T00:00:00.000Z' } } });
  const u = await getUsage({ APIFY_TOKEN: 't' }, fetchFn);
  assert.deepEqual(u, { usedUsd: 1.23, limitUsd: 5, ratio: 1.234 / 5, cycleStart: '2026-11-01T00:00:00.000Z', cycleEnd: '2026-12-01T00:00:00.000Z' });
});
