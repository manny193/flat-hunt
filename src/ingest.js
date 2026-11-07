// Production ingest: same rules as processItems() in core/logic.js, but against SQL and CPU-light.
//   1. normalise + area keyword filter (string checks only)
//   2. exact duplicates via one post_keys lookup (url key, text hash)
//   3. fuzzy matching only against a SQL-selected candidate set (same area + kind, BHK compatible,
//      rent within ±12 %, posted in the last 60 days, max 100 most recent per post)
//   4. one atomic batch write
// A full ingest is ~4 queries regardless of batch size.

import { prepareItems, emptyReport, screenItem, makeContext, tokens, compatible, scoreCandidate, applyPost, newListing, newId, fingerprint, sameAreas, MATCH_THRESHOLD, RENT_WINDOW } from './core/logic.js';
import { bhkKey } from './db/repo.js';

const DAY = 864e5;
export const CANDIDATE_DAYS = 60;

const keysOf = p => {
  const k = [];
  if (p.urlKey) k.push('u:' + p.urlKey);
  else k.push('n:' + p.th + '|' + (p.group || ''));
  k.push('h:' + p.th);
  return k;
};

/**
 * @param repo   createRepo() instance
 * @param raw    array of raw items (Apify rows, phone scan posts, pasted posts)
 * @param opts   {source, now?, datasetId?, sample?, areas?, settings?, idFn?}
 * @returns {report, changed: listing ids, timings}
 */
export async function ingestItems(repo, raw, opts) {
  const now = opts.now ?? Date.now();
  const t0 = performance.now();
  const source = opts.source || 'scraper';
  const [areas, settings] = await Promise.all([opts.areas ?? repo.listAreas(), opts.settings ?? repo.getSettings()]);
  const ctx = makeContext(areas, settings);
  const prepared = prepareItems(raw);
  const report = emptyReport(source, now, prepared.items.length);
  report.unscrapable = prepared.unscrapable;
  if (opts.datasetId) report.datasetId = opts.datasetId;

  // 1. screen
  const posts = [];
  for (const r of prepared.items) { const s = screenItem(r, source, ctx, report, now); if (s) posts.push(s); }

  // 2. exact keys (one query)
  const allKeys = [...new Set(posts.flatMap(s => keysOf(s.p)))];
  const known = await repo.lookupKeys(allKeys);

  // Posts that need fuzzy matching: no url/text-hash hit in the DB.
  const specs = [];
  posts.forEach((s, i) => {
    const { p, ex } = s; const k = keysOf(p);
    if (k.some(x => known.has(x))) return;
    const lo = ex.rent ? Math.floor(ex.rent * (1 - RENT_WINDOW)) : null, hi = ex.rent ? Math.ceil(ex.rent / (1 - RENT_WINDOW)) : null;
    for (const a of (p.areas.length ? p.areas : [0])) specs.push({ i, a, k: ex.kind, b: bhkKey(ex.bhk), lo, hi });
  });
  // 3. candidates (one query)
  const candRows = await repo.candidates(specs, now - CANDIDATE_DAYS * DAY);
  const candByPost = new Map(); const slim = new Map();
  for (const c of candRows) { slim.set(c.id, c); for (const qi of c.qis) { let a = candByPost.get(qi); if (!a) candByPost.set(qi, a = []); a.push(c); } }
  const tCand = performance.now();

  // Sequential decisions. New listings are built in memory immediately; merges into stored
  // listings are queued and replayed after one bulk load.
  const keyMap = new Map(known);               // key -> listing id (DB or batch-local)
  const local = new Map();                     // batch-local new listings
  const localSlim = new Map();                 // their match fields, refreshed after each merge
  const slimOf = l => ({ id: l.id, kind: l.kind, bhk: l.bhk, rent: l.rent, phones: l.phones, areas: l.areas || [], fp: fingerprint(l) });
  const dbMerges = [];                         // [listingId, s]
  const newKeys = [];
  const idFn = opts.idFn || newId;
  const remember = (p, id) => { for (const k of keysOf(p)) if (!keyMap.has(k)) { keyMap.set(k, id); newKeys.push({ k, l: id }); } };

  posts.forEach((s, i) => {
    const { p, ex } = s;
    const k = keysOf(p);
    // exact duplicate: same post url, or same text in the same group with no url
    if (keyMap.has(k[0])) { report.dupes++; return; }
    let target = keyMap.get(k[1]) || null;      // same text elsewhere -> repost
    if (!target) {
      const tok = tokens(p.text); let best = 0;
      for (const c of candByPost.get(i) || []) {
        const cur = slim.get(c.id);
        if (!compatible(cur, ex)) continue;
        const sc = scoreCandidate(tok, ex, cur); if (sc > best) { best = sc; target = c.id; }
      }
      for (const c of localSlim.values()) {
        if (!compatible(c, ex) || !sameAreas(p.areas, c.areas)) continue;
        const sc = scoreCandidate(tok, ex, c); if (sc > best) { best = sc; target = c.id; }
      }
      if (best < MATCH_THRESHOLD) target = null;
    }
    if (!target) {
      const l = newListing(p, ex, now, idFn());
      if (opts.sample) l.isSample = true;
      local.set(l.id, l); localSlim.set(l.id, slimOf(l)); remember(p, l.id); report.newListings++;
      return;
    }
    report.merged++;
    remember(p, target);
    if (local.has(target)) { const l = applyPost(local.get(target), p, ex, now); localSlim.set(l.id, slimOf(l)); return; }
    dbMerges.push([target, s]);
    // keep the slim copy roughly current for later posts in this batch
    const c = slim.get(target);
    if (c) {
      c.phones = [...new Set([...c.phones, ...ex.phones])];
      c.fp = [[...tokens(p.text)].join(' '), ...c.fp].slice(0, 5); c._sets = null;
      if (c.bhk == null) c.bhk = ex.bhk;
      if (ex.rent && !c.rent) c.rent = ex.rent;
    }
  });

  // Replay merges into stored listings (one query to load them).
  const loaded = await repo.loadListings([...new Set(dbMerges.map(m => m[0]))]);
  for (const [id, s] of dbMerges) { const l = loaded.get(id); if (l) applyPost(l, s.p, s.ex, now); }
  const changed = [...local.values(), ...loaded.values()];
  const tDecide = performance.now();

  // 4. write (one batch)
  await repo.saveIngest({ listings: changed, keys: newKeys, run: { source, datasetId: opts.datasetId, report }, now });
  const t1 = performance.now();
  return { report, changed: changed.map(l => l.id), timings: { totalMs: t1 - t0, candidatesMs: tCand - t0, decideMs: tDecide - tCand, writeMs: t1 - tDecide, candidates: candRows.length } };
}
