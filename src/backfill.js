// When an area is created (or gets new keywords), stored posts that mention it are tagged with it.
// Posts are stored whether or not they match an area, so a new area shows existing listings at once
// instead of waiting for new posts. Work is chunked by rowid range and resumable: the request that
// creates the area runs a few chunks, the hourly cron finishes the rest within its D1 query budget.
// State: settings.areaBackfill = { [areaId]: { next, max, startedAt, matched } }.

export const CHUNK_ROWS = 4000;
const QUERIES_PER_CHUNK = 4; // 3-statement batch + progress write (amortised)

const esc = s => s.replace(/[\\%_]/g, c => '\\' + c);
/** LIKE patterns for an area's keywords: the phrase and its joined form ("green glen", "greenglen"). */
export function likePatterns(keywords) {
  const set = new Set();
  for (const k of (keywords || []).slice(0, 10)) { if (k.length >= 3) set.add(k); const c = k.replace(/\s+/g, ''); if (c.length >= 3) set.add(c); }
  return [...set].slice(0, 16).map(k => `%${esc(k)}%`);
}
export const backfillState = (settings, areaId) => (settings?.areaBackfill || {})[areaId] || null;

/** Queue an area for backfill, then run up to `inlineChunks` chunks now. */
export async function startBackfill(repo, area, now = Date.now(), { inlineChunks = 6 } = {}) {
  const max = await repo.maxListingRowid();
  const st = (await repo.getSettings()).areaBackfill || {};
  if (!max) { delete st[area.id]; await repo.putSettings({ areaBackfill: st }); return { done: true, matched: 0 }; }
  st[area.id] = { next: 0, max, startedAt: now, matched: 0 };
  await repo.putSettings({ areaBackfill: st });
  return runBackfill(repo, { maxQueries: inlineChunks * QUERIES_PER_CHUNK, now });
}

/** Continue queued backfills within a D1 query budget. Returns {done, chunks, matched}. */
export async function runBackfill(repo, { maxQueries = 20, now = Date.now() } = {}) {
  const settings = await repo.getSettings();
  const st = { ...(settings.areaBackfill || {}) };
  const ids = Object.keys(st);
  if (!ids.length) return { done: true, chunks: 0, matched: 0 };
  let used = 2, chunks = 0, matched = 0;
  const areas = new Map((await repo.listAreas()).map(a => [String(a.id), a]));
  for (const id of ids) {
    const a = areas.get(id), job = st[id];
    if (!a) { delete st[id]; continue; }
    const patterns = likePatterns(a.keywords);
    while (job.next < job.max && used + QUERIES_PER_CHUNK <= maxQueries) {
      const to = Math.min(job.max, job.next + CHUNK_ROWS);
      const n = await repo.backfillChunk(a.id, patterns, job.next, to, now);
      job.next = to; job.matched = (job.matched || 0) + n; matched += n; chunks++; used += 3;
    }
    if (job.next >= job.max) delete st[id];
    if (used + QUERIES_PER_CHUNK > maxQueries) break;
  }
  await repo.putSettings({ areaBackfill: st });
  return { done: !Object.keys(st).length, chunks, matched };
}
