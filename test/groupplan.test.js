// Group rotation planner (docs/ai/GROUP-SCHEDULING.md): pure rules, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierOf, smoothYield, lookbackFor, dailyAllowance, allocate, echoOf, planCohorts, groupStats, isGroupDue, groupCutoff, lastSampleTarget, manualAction, PLAN_DEFAULTS, PLAN } from '../src/groupplan.js';
import { groupId } from '../src/groups.js';

const H = 36e5, D = 24 * H;
const NOW = Date.UTC(2026, 10, 10, 8, 30); // 14:00 IST
const P = { ...PLAN_DEFAULTS, enabled: true };
const url = n => `https://www.facebook.com/groups/${n}`;
const G = n => ({ id: groupId(url(n)), name: 'G' + n, url: url(n) });
// stats row: rows and usable over 7 days, read for `h` hours (rate = rows / h)
const st = (rows7, usable7, h = 168, extra = {}) => ({ rows7, usable7, cross7: 0, crossBy: {}, coveredH7: h, rate: rows7 / h, yield: smoothYield(usable7, rows7), rawYield: rows7 ? usable7 / rows7 : null, per6h: usable7 / h * 6, crossShare: 0, echoOf: null, fails: 0, trial: { rows: 0, usable: 0, usd: 0 }, ...extra });

test('tiers by usable posts per 6 h; smoothed yield on tiny samples; sample lookback ladder', () => {
  assert.equal(tierOf(4, P), 'hot'); assert.equal(tierOf(3.99, P), 'normal'); assert.equal(tierOf(1.5, P), 'normal'); assert.equal(tierOf(1.49, P), 'cold'); assert.equal(tierOf(null, P), 'normal');
  assert.equal(smoothYield(0, 0), 0.35, 'no data: the prior');
  assert.ok(Math.abs(smoothYield(0, 5) - 0.28) < 1e-9, '5 rows, none usable, is not ranked as 0 %');
  assert.ok(smoothYield(60, 100) > 0.55 && smoothYield(60, 100) < 0.6);
  assert.equal(lookbackFor(1), 12); assert.equal(lookbackFor(0.5), 6); assert.equal(lookbackFor(0.3), 3); assert.equal(lookbackFor(0.2), 2); assert.equal(lookbackFor(0.01), 1, 'never below the smallest step');
});

test('daily allowance: remaining credit over days left; spent today counts; never above credit; cycle rollover resets; zero budget stops', () => {
  const end = new Date(NOW + 10 * D).toISOString();
  const a = dailyAllowance({ budgetUsd: 5, usage: { usedUsd: 1.75, limitUsd: 5, cycleEnd: end }, spentTodayUsd: 0, now: NOW });
  assert.equal(a.capUsd, 4.75);
  assert.ok(a.daysLeft > 10 && a.daysLeft < 11, 'counted from the start of today (IST)');
  assert.ok(Math.abs(a.allowanceUsd - 3 / a.daysLeft) < 1e-3);
  assert.equal(a.tickUsd, a.allowanceUsd);
  const b = dailyAllowance({ budgetUsd: 5, usage: { usedUsd: 1.9, limitUsd: 5, cycleEnd: end }, spentTodayUsd: 0.15, now: NOW });
  assert.ok(Math.abs(b.allowanceUsd - a.allowanceUsd) < 1e-3, "today's spend does not shrink today's allowance");
  assert.ok(Math.abs(b.tickUsd - (b.allowanceUsd - 0.15)) < 1e-3, 'what is left of it today');
  assert.equal(dailyAllowance({ budgetUsd: 5, usage: { usedUsd: 4.9, limitUsd: 5, cycleEnd: end }, now: NOW }).tickUsd, 0, 'never above 95 % of the credit');
  assert.equal(dailyAllowance({ budgetUsd: 2, usage: { usedUsd: 0, limitUsd: 5, cycleEnd: end }, now: NOW }).capUsd, 1.9, 'the lower of budget and Apify limit');
  const roll = dailyAllowance({ budgetUsd: 5, usage: { usedUsd: 4.9, limitUsd: 5, cycleEnd: new Date(NOW - D).toISOString() }, spentTodayUsd: 0, now: NOW });
  assert.ok(roll.allowanceUsd > 0.1, 'a reading from the previous cycle: spend starts again from 0');
  assert.ok(roll.cycleEnd > NOW);
  assert.equal(dailyAllowance({ budgetUsd: 5, usage: { usedUsd: 0, limitUsd: 0.0001, cycleEnd: end }, now: NOW }).tickUsd < 0.0001, true, 'a zero credit pauses runs');
});

test('allocate: orders by value, fills the budget, then samples, then pauses for budget; spend never above the allowance', () => {
  const groups = [1, 2, 3, 4, 5, 6, 7, 8].map(G);
  const state = Object.fromEntries(groups.map(g => [g.id, { status: 'active', why: 'x', at: NOW - 30 * D }]));
  // all 1.5 rows/h (full cost 1.5 x 24 x 0.0012 = $0.0432 a day); yields differ
  const yields = [0.7, 0.3, 0.6, 0.5, 0.4, 0.35, 0.45, 0.55];
  const stats = Object.fromEntries(groups.map((g, i) => [g.id, st(252, Math.round(252 * yields[i]))]));
  const r = allocate({ groups, state, stats, plan: { ...P, minActive: 2, reservePct: 0 }, allowanceUsd: 0.15, now: NOW });
  const s = r.state;
  const full = groups.filter(g => s[g.id].mode === 'full').map(g => g.name);
  assert.deepEqual(full, ['G1', 'G3', 'G8'], 'three best by yield get full coverage');
  assert.equal(s[G(4).id].status, 'sample'); assert.ok(s[G(4).id].coverage > 0.4 && s[G(4).id].coverage < 0.5, 'the next one gets what is left');
  assert.equal(s[G(4).id].lookbackH, 3);
  for (const n of [2, 5, 6, 7]) { assert.equal(s[G(n).id].status, 'paused'); assert.equal(s[G(n).id].why, 'budget'); }
  assert.ok(r.summary.projectedDailyUsd <= 0.15 + 1e-6, `projected ${r.summary.projectedDailyUsd}`);
  assert.ok(r.events.every(e => e.why && e.at === NOW));
});

test('minActive: if full coverage of 6 costs more than the allowance, the best 6 are sampled instead of paused', () => {
  const groups = [1, 2, 3, 4, 5, 6, 7].map(G);
  const state = Object.fromEntries(groups.map(g => [g.id, { status: 'active', why: 'x', at: NOW - 30 * D }]));
  const stats = Object.fromEntries(groups.map((g, i) => [g.id, st(504, 252 - i * 10)])); // 3 rows/h: $0.0864 a day each
  const r = allocate({ groups, state, stats, plan: { ...P, minActive: 6, reservePct: 0 }, allowanceUsd: 0.15, now: NOW });
  const reading = groups.filter(g => ['active', 'sample'].includes(r.state[g.id].status));
  assert.equal(reading.length, 6, 'six groups still read');
  assert.equal(r.state[G(7).id].status, 'paused', 'the weakest waits');
  assert.ok(reading.every(g => r.state[g.id].mode === 'sample'));
  assert.ok(r.summary.projectedDailyUsd <= 0.15 + 1e-6, 'and the money is shared, not overspent');
  assert.equal(r.summary.reading, 6);
});

test('trial: new groups queue then start trial to reach minActive; early pause; verdict at day 7; spend cap ends it', () => {
  const groups = [1, 2, 3].map(G);
  let r = allocate({ groups, state: {}, stats: {}, plan: { ...P, minActive: 2 }, allowanceUsd: 0.15, now: NOW });
  assert.equal(r.state[G(1).id].status, 'trial'); assert.equal(r.state[G(1).id].why, 'new group');
  assert.equal(r.state[G(2).id].status, 'trial');
  assert.equal(r.state[G(1).id].since, NOW);
  assert.equal(r.state[G(1).id].history.length, 2, 'queued, then trial');
  assert.equal(r.state[G(1).id].mode, 'sample'); assert.equal(r.state[G(1).id].lookbackH, 6);
  // the third is funded from the reserve or spare money, else it waits in the pool
  const tight = allocate({ groups, state: {}, stats: {}, plan: { ...P, minActive: 2, reservePct: 0 }, allowanceUsd: 0.03, now: NOW });
  assert.equal(tight.state[G(3).id].status, 'paused'); assert.equal(tight.state[G(3).id].why, 'queued for trial');
  assert.equal(tight.summary.pool, 1);

  const t0 = { status: 'trial', why: 'new group', at: NOW - 4 * D, since: NOW - 4 * D, history: [] };
  r = allocate({ groups: [G(1)], state: { [G(1).id]: t0 }, stats: { [G(1).id]: st(40, 2, 48, { trial: { rows: 40, usable: 2, usd: 0.05 } }) }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[G(1).id].status, 'paused'); assert.equal(r.state[G(1).id].why, 'low yield', 'day 3+, 20+ rows, under 10 %: paused early');

  const t7 = { ...t0, at: NOW - 7 * D, since: NOW - 7 * D };
  r = allocate({ groups: [G(1)], state: { [G(1).id]: t7 }, stats: { [G(1).id]: st(60, 24, 84, { trial: { rows: 60, usable: 24, usd: 0.07 } }) }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[G(1).id].status, 'active'); assert.equal(r.state[G(1).id].why, 'passed trial');
  r = allocate({ groups: [G(1)], state: { [G(1).id]: t7 }, stats: { [G(1).id]: st(60, 9, 84, { trial: { rows: 60, usable: 9, usd: 0.07 } }) }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[G(1).id].why, 'low yield', '15 % at day 7: paused');
  const t2 = { ...t0, at: NOW - 2 * D, since: NOW - 2 * D };
  r = allocate({ groups: [G(1)], state: { [G(1).id]: t2 }, stats: { [G(1).id]: st(130, 60, 24, { trial: { rows: 130, usable: 60, usd: 0.16 } }) }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[G(1).id].status, 'active', 'the $0.15 trial cap ends a trial early');
});

test('existing groups with a week of data are judged at once instead of queued', () => {
  const r = allocate({ groups: [G(1), G(2)], state: {}, stats: { [G(1).id]: st(100, 50), [G(2).id]: st(100, 5) }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[G(1).id].status, 'active'); assert.equal(r.state[G(1).id].why, 'judged on last 7 days');
  assert.equal(r.state[G(2).id].status, 'paused'); assert.equal(r.state[G(2).id].why, 'low yield');
});

test('rotation: hysteresis, low yield pause promotes a cooled-off group, retry after retryDays, 3 failures pause, manual is never overridden, history keeps 10', () => {
  const [a, b, c] = [G(1), G(2), G(3)];
  const bad = st(100, 5);
  // changed status 3 days ago: kept despite low yield (hysteresis)
  let r = allocate({ groups: [a], state: { [a.id]: { status: 'active', why: 'x', at: NOW - 3 * D } }, stats: { [a.id]: bad }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[a.id].status, 'active');
  // a week later it is paused, and the paused group whose cool-off passed is re-tried to keep minActive
  const state = { [a.id]: { status: 'active', why: 'x', at: NOW - 8 * D }, [b.id]: { status: 'paused', why: 'low yield', at: NOW - 31 * D }, [c.id]: { status: 'paused', why: 'low yield', at: NOW - 5 * D } };
  r = allocate({ groups: [a, b, c], state, stats: { [a.id]: bad }, plan: { ...P, minActive: 1, reservePct: 0 }, allowanceUsd: 0.02, now: NOW });
  assert.equal(r.state[a.id].status, 'paused'); assert.equal(r.state[a.id].why, 'low yield');
  assert.equal(r.state[b.id].status, 'trial'); assert.equal(r.state[b.id].why, 'retry after cool-off');
  assert.equal(r.state[c.id].status, 'paused', 'cool-off not over: stays in the pool');
  // failures
  r = allocate({ groups: [a], state: { [a.id]: { status: 'active', why: 'x', at: NOW - D } }, stats: { [a.id]: st(50, 25, 100, { fails: 3 }) }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[a.id].status, 'paused'); assert.equal(r.state[a.id].why, 'unscrapable');
  r = allocate({ groups: [a], state: { [a.id]: { status: 'active', why: 'x', at: NOW - D } }, stats: { [a.id]: st(50, 25, 100, { fails: 2 }) }, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[a.id].status, 'active', 'two failures: still read');
  // manual pause and manual promote survive everything
  const mp = manualAction({ status: 'active', why: 'x', at: NOW - 40 * D }, 'pause', NOW - 40 * D);
  r = allocate({ groups: [a], state: { [a.id]: mp }, stats: { [a.id]: st(100, 90) }, plan: { ...P, minActive: 6 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[a.id].status, 'paused'); assert.equal(r.state[a.id].why, 'manual');
  const pr = manualAction({ status: 'paused', why: 'low yield', at: NOW - D }, 'promote', NOW - D);
  r = allocate({ groups: [a], state: { [a.id]: pr }, stats: { [a.id]: st(100, 1, 168, { fails: 5 }) }, plan: P, allowanceUsd: 0, now: NOW });
  assert.equal(r.state[a.id].status, 'active', 'promoted by hand: never paused, even with no money or failures');
  const rs = manualAction(mp, 'resume', NOW);
  assert.equal(rs.status, 'trial'); assert.equal(rs.manual, false); assert.equal(rs.since, NOW);
  assert.equal(manualAction({}, 'explode', NOW), null);
  // history is capped
  let s = { status: 'active', why: 'x', at: 0 };
  for (let i = 0; i < 14; i++) s = manualAction(s, i % 2 ? 'pause' : 'resume', NOW + i);
  assert.equal(s.history.length, PLAN.historyMax);
  assert.equal(s.history.at(-1).at, NOW + 13);
});

test('echo: the partner with the lower yield is paused, symmetrically and only if the partner is still read', () => {
  const [a, b] = [G(1), G(2)];
  const sa = st(100, 20, 168, { crossShare: 0.7, echoOf: b.id, crossBy: { [b.id]: 70 } });
  const sb = st(100, 50, 168, { crossShare: 0.65, echoOf: a.id, crossBy: { [a.id]: 65 } });
  const stats = { [a.id]: sa, [b.id]: sb };
  const state = { [a.id]: { status: 'active' }, [b.id]: { status: 'active' } };
  assert.deepEqual(echoOf(a.id, stats, state, P), { of: b.id, share: 0.7 });
  assert.equal(echoOf(b.id, stats, state, P), null, 'never both');
  assert.equal(echoOf(a.id, stats, { ...state, [b.id]: { status: 'paused' } }, P), null, 'partner paused: keep this one');
  const r = allocate({ groups: [a, b], state: { [a.id]: { status: 'active', at: NOW - 10 * D }, [b.id]: { status: 'active', at: NOW - 10 * D } }, stats, plan: { ...P, minActive: 1 }, allowanceUsd: 1, now: NOW });
  assert.equal(r.state[a.id].status, 'paused'); assert.equal(r.state[a.id].why, 'echo'); assert.equal(r.state[b.id].status, 'active');
  // equal yields: the higher rate stays
  const e1 = st(100, 40, 100, { crossShare: 0.7, echoOf: b.id }), e2 = st(100, 40, 50, { crossShare: 0.7, echoOf: a.id });
  assert.ok(echoOf(a.id, { [a.id]: e1, [b.id]: e2 }, state, P) !== null && echoOf(b.id, { [a.id]: e1, [b.id]: e2 }, state, P) === null);
});

test('groupStats: names resolve to watched ids, coverage hours give the rate, cross-posts, consecutive failures, trial window', () => {
  const settings = { groups: [{ name: 'Bellandur Flats', url: url(111) }, { name: 'HSR Rooms', url: url(222) }] };
  const a = groupId(url(111)), b = groupId(url(222));
  const run = (t, f, n, x = {}, u = [], caps = { after: t - 2 * H, groupIds: [a, b] }) => ({ startedAt: t, report: { fetchedByGroup: f, newByGroup: n, crossFrom: x, unscrapable: u, caps } });
  const rows = [
    run(NOW - 10 * D, { 'Bellandur Flats': 50 }, { 'Bellandur Flats': 25 }),
    run(NOW - 3 * D, { 'Bellandur Flats': 10, 'HSR Rooms': 8 }, { 'Bellandur Flats': 5, 'HSR Rooms': 1 }, { 'HSR Rooms': { 'Bellandur Flats': 6 } }, [{ name: 'HSR Rooms', reason: 'private' }]),
    run(NOW - 2 * D, { 'Bellandur Flats': 6 }, { 'Bellandur Flats': 3 }, {}, [{ name: 'HSR Rooms', reason: 'private' }]),
    run(NOW - 1 * D, { 'Bellandur Flats': 4 }, { 'Bellandur Flats': 2 }, {}, [{ url: url(222), reason: 'private' }]),
  ];
  const s = groupStats(rows, settings, { now: NOW, cycleStart: NOW - 20 * D, price: 0.0012, since: { [a]: NOW - 2.5 * D } });
  assert.equal(s[a].rows7, 20); assert.equal(s[a].usable7, 10); assert.equal(s[a].rowsCycle, 70);
  assert.equal(s[a].coveredH7, 6); assert.ok(Math.abs(s[a].rate - 20 / 6) < 1e-9);
  assert.ok(Math.abs(s[a].per6h - 10) < 1e-9);
  assert.equal(s[b].cross7, 6); assert.equal(s[b].echoOf, a); assert.ok(Math.abs(s[b].crossShare - 0.75) < 1e-9);
  assert.equal(s[b].fails, 3, 'three runs in a row unscrapable (by name or by link)');
  assert.equal(s[a].fails, 0);
  assert.equal(s[a].trial.rows, 10, 'trial numbers only since the trial started');
  assert.equal(s[a].usd7, 0.024);
});

test('planCohorts: equal cutoffs share a run, near ones merge, at most 3 runs; sample uses the lookback; caps and the tick allowance', () => {
  const opts = { now: NOW, overlapMs: 5 * 60e3, floor: NOW - 3 * D, perGroup: 30, price: 0.0012 };
  const gs = [1, 2, 3, 4, 5, 6, 7, 8].map(G);
  const S = {};
  S[gs[0].id] = { status: 'active', mode: 'full', tier: 'hot', lastRead: NOW - 2 * H, rate: 2 };
  S[gs[1].id] = { status: 'active', mode: 'full', tier: 'hot', lastRead: NOW - 2 * H, rate: 1 };
  S[gs[2].id] = { status: 'active', mode: 'full', tier: 'hot', lastRead: NOW - 2.5 * H, rate: 1 }; // within the hour: merged
  S[gs[3].id] = { status: 'sample', mode: 'sample', lookbackH: 3, tier: 'cold', lastRead: NOW - 20 * H, rate: 1 };
  S[gs[4].id] = { status: 'trial', mode: 'sample', lookbackH: 6, tier: 'normal', rate: null }; // never read: now - 6 h
  S[gs[5].id] = { status: 'active', mode: 'full', tier: 'normal', lastRead: NOW - 30 * H, rate: 1 };
  S[gs[6].id] = { status: 'active', mode: 'full', tier: 'normal', lastRead: NOW - 18 * H, rate: 1 };
  S[gs[7].id] = { status: 'paused', why: 'budget' };
  let p = planCohorts({ groups: gs, state: S, ...opts });
  assert.equal(p.due, 7, 'paused groups are not read');
  assert.equal(p.cohorts.length, 3); assert.equal(p.waiting, 1, 'a fourth cutoff waits for the next slot');
  const hot = p.cohorts.find(c => c.groupIds.includes(gs[0].id));
  assert.deepEqual(hot.groupIds.sort(), [gs[0].id, gs[1].id, gs[2].id, gs[3].id].sort(), 'cutoffs within an hour (2 h, 2.5 h, sample 3 h) share one run');
  assert.equal(hot.after, NOW - 3 * H, 'merged cohort takes the earliest cutoff');
  assert.ok(!p.cohorts.some(c => c.groupIds.includes(gs[4].id)), 'the smallest, latest cohort waits');
  assert.ok(hot.maxItems >= 15 && hot.maxItems <= 90);
  assert.ok(hot.maxCharge <= 0.5);
  assert.equal(groupCutoff(S[gs[3].id], NOW, opts), NOW - 3 * H, 'sample: only the last 3 hours are bought');
  assert.equal(groupCutoff(S[gs[4].id], NOW, opts), NOW - 6 * H, 'trial start: 6 h lookback');
  assert.equal(groupCutoff({ ...S[gs[5].id] }, NOW, opts), NOW - 30 * H - 5 * 60e3, 'full: exact cutoff minus the overlap');
  // tick allowance scales the caps down
  p = planCohorts({ groups: gs.slice(0, 3), state: S, ...opts, tickUsd: 0.02 });
  const total = p.cohorts.reduce((a, c) => a + c.maxCharge + PLAN.runUsd, 0);
  assert.ok(total <= 0.02 + 1e-9, `caps ${total}`); assert.ok(p.cohorts.every(c => c.scaled));
  // recovery cohort first, with the largest posts-per-group
  const R = { [gs[0].id]: { ...S[gs[0].id], recoverNext: true } };
  p = planCohorts({ groups: [gs[0]], state: R, ...opts });
  assert.equal(p.cohorts[0].recover, true); assert.equal(p.cohorts[0].perGroup, 50);
});

test('due rules: hot every slot, normal every ~4 h, sample and trial at 13:00 and 21:00 IST', () => {
  const t13 = lastSampleTarget(NOW); // NOW is 14:00 IST
  assert.equal(new Date(t13 + 5.5 * H).getUTCHours(), 13);
  assert.equal(isGroupDue({ status: 'active', mode: 'full', tier: 'hot', lastRead: NOW - H }, NOW), true);
  assert.equal(isGroupDue({ status: 'active', mode: 'full', tier: 'normal', lastRead: NOW - 2 * H }, NOW), false);
  assert.equal(isGroupDue({ status: 'active', mode: 'full', tier: 'normal', lastRead: NOW - 4 * H }, NOW), true);
  assert.equal(isGroupDue({ status: 'sample', mode: 'sample', lastRead: t13 - H }, NOW), true, 'not read since 13:00');
  assert.equal(isGroupDue({ status: 'sample', mode: 'sample', lastRead: t13 + 10 * 60e3 }, NOW), false);
  assert.equal(isGroupDue({ status: 'paused' }, NOW), false);
  assert.equal(isGroupDue({ status: 'trial' }, NOW), true, 'a new trial starts at once');
});
