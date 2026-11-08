// Pure logic for the admin "Finance & budget" page (docs/design/FINANCE.md): formatting, the what-if
// maths, the verdict sentence and the "What to change" rules. No DOM, so test/finance.test.js imports it.
// F is the GET /api/admin/finance response.

const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
export const MONTH_DAYS = 30.4;
export const WEEKS_PER_MONTH = 4.35; // weekly group-details rows (docs/APIFY.md)

export const usd2 = v => v == null || !Number.isFinite(Number(v)) ? '–' : '$' + Number(v).toFixed(2);
export const cents = v => v == null || !Number.isFinite(Number(v)) ? '–' : '$' + Number(v).toFixed(3);
export const fdate = t => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
export const ftime = t => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
/**
 * Axis maximum for money, drawn with 4 equal steps (axes()): the step is a whole number of cents from
 * 1, 2, 2.5, 5 × 10^k (never 2.5 cents), so every tick label is exact. $0.31 -> $0.40, $0.50 -> $0.80, $6.45 -> $8.
 */
export function niceMoney(v) {
  const want = Math.max(1, Math.ceil(v * 100) / 4); // cents per step
  for (let p = 1; ; p *= 10) for (const m of [1, 2, 2.5, 5]) { const step = m * p; if (step >= want && Number.isInteger(step)) return (4 * step) / 100; }
}
/** Axis tick label: "$0", "$2.50", "$5". */
export const moneyTick = t => '$' + (Math.abs(t - Math.round(t)) < 1e-9 ? String(Math.round(t)) : t.toFixed(2));

/** Lower is better, so cheaper is good (keep) and dearer is amber, never red. */
export function costDelta(cur, prev) {
  if (cur == null || !prev) return 'no earlier data';
  const pct = Math.round(100 * (cur - prev) / prev);
  if (pct === 0) return 'same as previous 7 days';
  if (pct < 0) return `<span class="up">${Math.abs(pct)}% cheaper</span> than previous 7 days`;
  return `<span class="warn-t">+${pct}% dearer</span> than previous 7 days`;
}

/**
 * Monthly cost of a scenario (spec §3G). i = {groups, pph, price, runsPerDay, platformPerRunUsd, budget,
 * limitUsd, stopPct, longestGapHours}.
 */
export function whatIfCost(i) {
  const postsUsd = i.groups * i.pph * 24 * MONTH_DAYS * i.price;
  const detailsUsd = i.groups * WEEKS_PER_MONTH * i.price;
  const platformUsd = i.runsPerDay * MONTH_DAYS * i.platformPerRunUsd;
  const perGroupUsd = i.pph * 24 * MONTH_DAYS * i.price + WEEKS_PER_MONTH * i.price;
  const monthlyUsd = postsUsd + detailsUsd + platformUsd;
  const cap = n => (perGroupUsd > 0 ? Math.max(0, Math.floor(n / perGroupUsd)) : Infinity);
  return {
    postsUsd, detailsUsd, platformUsd, monthlyUsd, perGroupUsd,
    maxGroups: cap(i.budget - platformUsd),
    maxFree: cap(i.limitUsd * i.stopPct / 100 - platformUsd),
    postsPerRun: Math.ceil(i.pph * i.longestGapHours),
    monthlyAt: g => g * perGroupUsd + platformUsd,
  };
}
/** The what-if inputs the page starts with. */
export const whatIfDefaults = F => ({
  groups: F.whatIf.activeGroups, pph: F.whatIf.postsPerGroupPerHour, price: F.whatIf.rowPriceUsd, runsPerDay: F.schedule.runsPerDay,
  platformPerRunUsd: F.whatIf.platformPerRunUsd, budget: F.budget.monthlyUsd, limitUsd: F.apify.usage?.limitUsd ?? F.forecast.limitUsd ?? 5,
  stopPct: F.schedule.budgetStopPct, longestGapHours: F.schedule.longestGapHours,
});

export const STATUS_PILL = { ok: ['ok', 'Inside budget'], watch: ['warn', 'On track to go over'], over: ['bad', 'Over budget'], unknown: ['', 'Not enough data yet'] };
/** Status pill [class, text]. */
export function statusPill(F) {
  if (!F.apify.configured) return ['', 'Nothing spent: Apify not connected'];
  if (F.forecast.status === 'watch') { const t = { warn: 'Near the warn level', paused: 'Scraping paused', pause: 'Scraping will pause' }[F.forecast.reason]; if (t) return ['warn', t]; }
  return STATUS_PILL[F.forecast.status] || STATUS_PILL.unknown;
}

/** The one-paragraph verdict (spec §3B): {s: data-s value, html, sub: html|null}. */
export function verdict(F) {
  const f = F.forecast, b = F.budget.monthlyUsd, u = F.apify.usage, sch = F.schedule;
  const end = fdate(F.cycle.end);
  if (!F.apify.configured) return { s: 'none', html: "Nothing is being spent. Apify isn't connected (APIFY_TOKEN is not set), so Facebook groups aren't scraped. Reddit, phone scans and AI extraction are free.", sub: null };
  const pause = f.paused ? ` Scraping is paused until ${end}.` : f.pauseAt && f.pauseAt > F.now && f.pauseAt < F.cycle.end ? ` Scraping pauses on ${fdate(f.pauseAt)} when Apify credit hits ${sch.budgetStopPct}%.` : '';
  const next = !sch.enabled ? ' Scraping is switched off in Schedule.' : sch.nextRunAt ? ` The next run is at ${ftime(sch.nextRunAt)}.` : '';
  let html;
  if (f.status === 'over' && f.reason === 'credit') html = `<strong>Over budget.</strong> Apify credit is used up (${usd2(u?.usedUsd)} of ${usd2(u?.limitUsd)}). Scraping is paused until ${end}.`;
  else if (f.status === 'over') html = `<strong>Over budget.</strong> ${usd2(f.mtdUsd)} spent of your ${usd2(b)} budget, with ${Math.ceil(F.cycle.daysLeft)} days left in the cycle.${pause}`;
  else if (f.status === 'watch' && f.reason === 'warn') html = `<strong>Near the warn level.</strong> Apify credit is ${Math.round(100 * (u?.ratio || 0))}% used, so each run fetches half as many posts per group until ${end}.`;
  else if (f.status === 'watch' && f.reason === 'paused') html = `<strong>Scraping paused.</strong> Apify credit is ${Math.round(100 * (u?.ratio || 0))}% used (${usd2(f.creditUsedUsd)} of ${usd2(f.limitUsd)}), past the ${sch.budgetStopPct}% stop level, so no runs start until ${end}. ${usd2(f.mtdUsd)} spent of your ${usd2(b)} budget.`;
  else if (f.status === 'watch' && f.reason === 'pause') html = `<strong>Scraping will pause.</strong> ${usd2(f.mtdUsd)} spent of your ${usd2(b)} budget. At ${usd2(f.forwardRateUsd)} a day the free credit reaches the ${sch.budgetStopPct}% stop level on ${fdate(f.pauseAt)}, and runs pause until ${end}. Spending stops near ${usd2(f.projectedUsd)}.`;
  else if (f.status === 'watch') html = `<strong>On track to go over.</strong> ${usd2(f.mtdUsd)} spent of your ${usd2(b)} budget. At ${usd2(f.forwardRateUsd)} a day you'll pass it around ${fdate(f.budgetAt)} and reach about ${usd2(f.projectedUsd)} by ${f.projectionCapped && f.pauseAt ? fdate(f.pauseAt) : end}.${pause}`;
  else if (f.status === 'ok' && !sch.enabled) html = `<strong>Inside budget.</strong> ${usd2(f.mtdUsd)} spent of your ${usd2(b)} budget. Scraping is switched off, so nothing more is spent this cycle.`;
  else if (f.status === 'ok') html = `<strong>Inside budget.</strong> ${usd2(f.mtdUsd)} spent of your ${usd2(b)} budget. At ${usd2(f.forwardRateUsd)} a day you'll end the cycle near ${usd2(f.projectedUsd)}, leaving ${usd2(b - f.projectedUsd)} spare.`;
  else if (!F.perDay.some(d => d.runs)) html = `<strong>Not enough data yet.</strong> No paid runs this cycle, so nothing has been spent.${next}`;
  else html = `<strong>Not enough data yet.</strong> ${usd2(f.mtdUsd)} spent so far. A forecast appears after the first full day of runs.`;
  let sub = null;
  if (F.apify.usageError) sub = `Apify usage couldn't be read (${escH(F.apify.usageError)}). Figures come from our run records.`;
  else if (!u) sub = "Apify usage couldn't be read, so this uses our own run records, which can miss small platform charges.";
  return { s: F.forecast.status, html, sub };
}

const quoteNames = names => { const q = names.slice(0, 3).map(n => `"${escH(n)}"`); const more = names.length - q.length; return (q.length > 1 ? q.slice(0, -1).join(', ') + ' and ' + q.at(-1) : q[0] || '') + (more > 0 ? ` and ${more} more` : ''); };
const SEV = { over: 0, watch: 1, tip: 2 };
const relative = (t, now) => { const m = Math.round((now - t) / 60e3); if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; const d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago'); };

/**
 * "What to change" (spec §3D, rules R1–R8). Returns at most 4 items, most severe first, then by saving:
 * {id, severity:'over'|'watch'|'tip', html, savingUsd|null, action:{href}|{act, label, k?}|null}.
 */
export function suggestions(F) {
  if (!F.apify.configured) return [{ id: 'R0', severity: 'tip', html: 'Connect Apify to scrape Facebook groups. Set APIFY_TOKEN on the server (see docs/APIFY.md).', savingUsd: null, action: null }];
  const f = F.forecast, b = F.budget.monthlyUsd, left = F.cycle.daysLeft, out = [];
  const usage = F.apify.usage; const limit = usage?.limitUsd ?? f.limitUsd ?? 5;
  const live = (F.groups || []).filter(g => g.active !== false && g.dailyUsd > 0);
  if (f.mtdUsd >= b) out.push({ id: 'R1', severity: 'over', html: `You've spent ${usd2(f.mtdUsd)}, past your ${usd2(b)} budget. Lower the stop level or pause groups to stop spending this cycle.`, savingUsd: null, action: { act: 'schedule', label: 'Open schedule' } });
  const named = new Set();
  const byValue = [...live].sort((x, y) => (x.listingsPerUsd ?? Infinity) - (y.listingsPerUsd ?? Infinity));
  // R2: the budget is crossed this cycle, before any guard pause (the server sets budgetAt only then).
  if (f.budgetAt && f.budgetAt > F.now && f.mtdUsd < b) {
    const raw = f.uncappedProjectedUsd ?? f.projectedUsd;
    const pick = []; let saved = 0;
    for (const g of byValue) { if (raw - saved <= b) break; pick.push(g); saved += g.dailyUsd * left; }
    pick.forEach(g => named.add(g.group));
    const after = Math.min(raw - saved, f.projectedUsd);
    const tail = pick.length ? ` Pausing ${quoteNames(pick.map(g => g.group))} would bring the cycle to about ${usd2(after)}.` : '';
    out.push({ id: 'R2', severity: 'watch', html: `At ${usd2(f.forwardRateUsd)} a day you'll pass your budget around ${fdate(f.budgetAt)}.${tail}`, savingUsd: pick.length && f.projectedUsd - after > 0 ? f.projectedUsd - after : null, action: { href: '#admin-groups', label: 'Review groups' } });
  }
  // R9: the Apify guard will pause scraping before the cycle ends.
  if (f.reason === 'pause' && f.pauseAt) {
    const room = Math.max(0, f.limitUsd * F.schedule.budgetStopPct / 100 - f.creditUsedUsd);
    const fits = left > 0 ? room / left : 0; // $/day that lasts to the cycle end
    const pick = []; let cut = 0;
    for (const g of byValue) { if (f.forwardRateUsd - cut <= fits) break; pick.push(g); cut += g.dailyUsd; }
    pick.forEach(g => named.add(g.group));
    const days = Math.max(1, Math.round((F.cycle.end - f.pauseAt) / DAY));
    const tail = pick.length && f.forwardRateUsd - cut <= fits ? ` Pausing ${quoteNames(pick.map(g => g.group))} would keep runs going to the end of the cycle.` : ' Fewer or quieter groups would keep runs going longer.';
    out.push({ id: 'R9', severity: 'watch', html: `At ${usd2(f.forwardRateUsd)} a day Apify credit reaches the ${F.schedule.budgetStopPct}% stop level on ${fdate(f.pauseAt)}, so scraping pauses for about ${days} day${days === 1 ? '' : 's'} until ${fdate(F.cycle.end)}.${tail}`, savingUsd: null, action: { href: '#admin-groups', label: 'Review groups' } });
  }
  // R10: the guard has already paused scraping.
  if (f.reason === 'paused') out.push({ id: 'R10', severity: 'watch', html: `Scraping is paused until ${fdate(F.cycle.end)}: Apify credit passed the ${F.schedule.budgetStopPct}% stop level. Raise the stop level, or move to a paid Apify plan, to resume sooner.`, savingUsd: null, action: { act: 'schedule', label: 'Open schedule' } });
  const spending = (f.forwardRateUsd ?? f.dailyRateUsd) > 0;
  const low = (F.groups || []).filter(g => g.lowValue && g.active !== false && !named.has(g.group));
  for (const g of low) out.push({ id: 'R3', severity: 'watch', html: `"${escH(g.group)}" cost ${usd2(g.cycleUsd)} this cycle for ${g.newListings} new listings (${g.yieldPct ?? 0}% of its posts). ${spending ? `Pausing it saves about ${usd2(g.dailyUsd * left)}.` : 'Consider swapping it for a busier group before runs resume.'}`, savingUsd: spending ? g.dailyUsd * left || null : null, action: { href: '#admin-groups', label: 'Review group' } });
  if ((F.capHits || []).length) {
    const n = F.capHits.length; const cap = F.capHits[0].cap ?? F.schedule.resultsPerGroup;
    out.push({ id: 'R4', severity: 'watch', html: `${n} group${n > 1 ? 's' : ''} hit the ${cap}-post cap in recent runs, so some posts were skipped: ${quoteNames(F.capHits.map(c => c.group))}. Add a run hour in the longest gap (${escH(F.schedule.longestGap)}) rather than raising the cap; extra runs cost about $0.0002 each.`, savingUsd: null, action: { act: 'schedule', label: 'Open schedule' } });
  }
  if (usage && b > usage.limitUsd && F.apify.plan === 'free') out.push({ id: 'R5', severity: 'tip', html: `Your budget is ${usd2(b)}, but the Apify free plan stops at ${usd2(limit)}. Spending can't pass ${usd2(limit)} unless you move to a paid Apify plan.`, savingUsd: null, action: { act: 'budget', label: 'Set budget' } });
  if (f.status === 'ok' && F.schedule.enabled && f.projectedUsd < 0.6 * b && !low.length) {
    const per = whatIfCost(whatIfDefaults(F)).perGroupUsd; const k = per > 0 ? Math.floor((b - f.projectedUsd) / per) : 0;
    if (k >= 1) out.push({ id: 'R6', severity: 'tip', html: `You have room for about ${k} more group${k > 1 ? 's' : ''} at today's rate (${usd2(per)} a month each). Try it in the calculator first.`, savingUsd: null, action: { act: 'calc', label: 'Try in calculator', k } });
  }
  for (const s of F.free || []) {
    if (!s.measured || !s.limit || s.used / s.limit < 0.8) continue;
    const pct = Math.round(100 * s.used / s.limit);
    out.push({ id: 'R7', severity: 'watch', html: `${escH(s.name)} used ${pct}% of its free ${s.period === 'day' ? 'daily' : escH(s.period)} allowance (${s.used.toLocaleString('en-US')} of ${s.limit.toLocaleString('en-US')} ${escH(s.unit)}).${s.id === 'workers_ai' ? ' Extraction falls back to rules when it runs out.' : ''}`, savingUsd: null, action: s.id === 'workers_ai' ? { href: '#admin-ai', label: 'Open AI extraction' } : null });
  }
  if (!usage?.checkedAt || F.now - usage.checkedAt > 6 * 36e5) out.push({ id: 'R8', severity: 'tip', html: usage?.checkedAt ? `Apify usage was last read ${relative(usage.checkedAt, F.now)}. Refresh to make the forecast exact.` : 'Apify usage has not been read yet. Refresh to make the forecast exact.', savingUsd: null, action: { act: 'refresh', label: 'Refresh usage' } });
  return out.sort((x, y) => SEV[x.severity] - SEV[y.severity] || (y.savingUsd || 0) - (x.savingUsd || 0)).slice(0, 4);
}
