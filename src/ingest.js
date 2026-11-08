// Production ingest: same rules as processItems() in core/logic.js, but against SQL and CPU-light.
//   1. normalise + area keyword filter (string checks only)
//   2. exact duplicates via one post_keys lookup (url key, text hash)
//   3. fuzzy matching only against a SQL-selected candidate set (same area + kind, BHK compatible,
//      rent within ±12 %, posted in the last 60 days, max 100 most recent per post)
//   4. one atomic batch write
// A full ingest is ~4 queries regardless of batch size.

import { pick, asName, GROUP_KEYS, prepareItems, emptyReport, screenItem, makeContext, tokens, compatible, scoreCandidate, applyPost, newListing, newId, fingerprint, sameAreas, mergeReports, sketches, postSketch, plausible, MATCH_THRESHOLD, RENT_WINDOW } from './core/logic.js';
import { bhkKey } from './db/repo.js';
import { ingestAlertStatements } from './alerts.js';

const DAY = 864e5;
export const CANDIDATE_DAYS = 60;

const keysOf = p => {
  if (p._keys) return p._keys;
  const k = p._keys = [];
  if (p.urlKey) k.push('u:' + p.urlKey);
  else k.push('n:' + p.th + '|' + (p.group || ''));
  k.push('h:' + p.th);
  return k;
};

/**
 * @param repo   createRepo() instance
 * @param raw    array of raw items (Apify rows, phone scan posts, pasted posts)
 * @param opts   {source, now?, datasetId?, sample?, areas?, settings?, idFn?, env? (AI hook),
 *                 groups? (group rows from earlier pages), run? {status, report, progress} for paged dataset ingest}
 * @returns {report (this batch), runReport (accumulated), groups, changed: listing ids, timings}
 * timings.jsMs is time outside DB calls: on Workers+D1 that is roughly the CPU the invocation is billed for.
 */
export async function ingestItems(repo, raw, opts) {
  const now = opts.now ?? Date.now();
  const t0 = performance.now(); let dbMs = 0;
  const db = async p => { const t = performance.now(); try { return await p(); } finally { dbMs += performance.now() - t; } };
  const source = opts.source || 'scraper';
  const [areas, settings] = await Promise.all([opts.areas ?? db(() => repo.listAreas()), opts.settings ?? db(() => repo.getSettings())]);
  const ctx = makeContext(areas, settings);
  ctx.storeAll = !!opts.storeAll; // production sources keep every housing post; area matching happens on read
  const prepared = prepareItems(raw, { groups: opts.groups, watched: Array.isArray(settings?.groups) ? settings.groups : [] });
  const report = emptyReport(source, now, prepared.items.length);
  report.unscrapable = prepared.unscrapable;

  // 1. screen. Per-group counts (posts fetched, posts in one of our areas) feed the admin stats.
  const posts = []; const fetchedByGroup = {}, matchedByGroup = {};
  const groupOf = r => (r && typeof r === 'object' ? asName(pick(r, GROUP_KEYS)) : '') || 'Group not detected';
  for (const r of prepared.items) {
    const g = groupOf(r); fetchedByGroup[g] = (fetchedByGroup[g] || 0) + 1;
    const s = screenItem(r, source, ctx, report, now);
    if (s) { posts.push(s); if (s.p.areas.length) matchedByGroup[g] = (matchedByGroup[g] || 0) + 1; }
  }
  report.fetchedByGroup = fetchedByGroup; report.matchedByGroup = matchedByGroup;

  const tScreen = performance.now();
  // 2. exact keys (one query)
  const allKeys = [...new Set(posts.flatMap(s => keysOf(s.p)))];
  const known = await db(() => repo.lookupKeys(allKeys));

  // Posts that need fuzzy matching: no url/text-hash hit in the DB.
  const specs = [];
  posts.forEach((s, i) => {
    const { p, ex } = s; const k = keysOf(p);
    if (k.some(x => known.has(x))) return;
    const lo = ex.rent ? Math.floor(ex.rent * (1 - RENT_WINDOW)) : null, hi = ex.rent ? Math.ceil(ex.rent / (1 - RENT_WINDOW)) : null;
    for (const a of (p.areas.length ? p.areas : [0])) specs.push({ i, a, k: ex.kind, b: bhkKey(ex.bhk), lo, hi });
  });
  // 3. candidates (one query)
  const candRows = await db(() => repo.candidates(specs, now - CANDIDATE_DAYS * DAY));
  const candByPost = new Map(); const slim = new Map();
  for (const c of candRows) { slim.set(c.id, c); for (const qi of c.qis) { let a = candByPost.get(qi); if (!a) candByPost.set(qi, a = []); a.push(c); } }
  // Sketch prefilter, then fetch token lists only for candidates that could plausibly match (one query).
  const toks = new Map(), psks = new Map(), need = new Set();
  for (const [i, list] of candByPost) {
    const { p, ex } = posts[i]; const tok = tokens(p.text); const psk = postSketch(tok);
    toks.set(i, tok); psks.set(i, psk);
    for (const c of list) if (!need.has(c.id) && compatible(c, ex) && plausible(psk, ex, c)) need.add(c.id);
  }
  const fps = await db(() => repo.fingerprints([...need]));
  for (const [id, raw] of fps) slim.get(id).fpRaw = raw;
  const tCand = performance.now();

  // Sequential decisions. New listings are built in memory immediately; merges into stored
  // listings are queued and replayed after one bulk load.
  const keyMap = new Map(known);               // key -> listing id (DB or batch-local)
  const local = new Map();                     // batch-local new listings
  const localSlim = new Map();                 // their match fields, refreshed after each merge
  const slimOf = l => ({ id: l.id, kind: l.kind, bhk: l.bhk, rent: l.rent, phones: l.phones, areas: l.areas || [], fp: fingerprint(l), sk: sketches(l) });
  const dbMerges = [];                         // [listingId, s]
  const newKeys = [];
  const idFn = opts.idFn || newId;
  // Cross-posts (docs/ai/GROUP-SCHEDULING.md 4.6): a merge into a listing whose first post came from another
  // group. The first group is read from listings already in memory, so this costs no extra query.
  const cross = (g, first) => { if (!first || first === g || g === 'Group not detected') return; const t = ((report.crossFrom ||= {})[g] ||= {}); t[first] = (t[first] || 0) + 1; };
  const remember = (p, id) => { for (const k of keysOf(p)) if (!keyMap.has(k)) { keyMap.set(k, id); newKeys.push({ k, l: id }); } };

  posts.forEach((s, i) => {
    const { p, ex } = s;
    const k = keysOf(p);
    // exact duplicate: same post url, or same text in the same group with no url
    const pg = p.group || 'Group not detected';
    if (keyMap.has(k[0])) { report.dupes++; (report.mergedByGroup ||= {})[pg] = (report.mergedByGroup[pg] || 0) + 1; return; }
    let target = keyMap.get(k[1]) || null;      // same text elsewhere -> repost
    if (!target) {
      const tok = toks.get(i) || tokens(p.text); const psk = psks.get(i) || postSketch(tok); let best = 0;
      for (const c of candByPost.get(i) || []) {
        const cur = slim.get(c.id);
        if (!compatible(cur, ex)) continue;
        const sc = scoreCandidate(tok, ex, cur, psk); if (sc > best) { best = sc; target = c.id; }
      }
      for (const c of localSlim.values()) {
        if (!compatible(c, ex) || !sameAreas(p.areas, c.areas)) continue;
        const sc = scoreCandidate(tok, ex, c, psk); if (sc > best) { best = sc; target = c.id; }
      }
      if (best < MATCH_THRESHOLD) target = null;
    }
    if (!target) {
      const l = newListing(p, ex, now, idFn());
      if (opts.sample) l.isSample = true;
      local.set(l.id, l); localSlim.set(l.id, slimOf(l)); remember(p, l.id); report.newListings++;
      const ng = p.group || 'Group not detected'; (report.newByGroup ||= {})[ng] = (report.newByGroup[ng] || 0) + 1;
      return;
    }
    report.merged++; (report.mergedByGroup ||= {})[pg] = (report.mergedByGroup[pg] || 0) + 1;
    remember(p, target);
    if (local.has(target)) { cross(pg, local.get(target).groups?.[0]); const l = applyPost(local.get(target), p, ex, now); localSlim.set(l.id, slimOf(l)); return; }
    dbMerges.push([target, s]);
    // keep the slim copy roughly current for later posts in this batch
    const c = slim.get(target);
    if (c) {
      c.phones = [...new Set([...c.phones, ...ex.phones])];
      const prev = c.fp ?? (c.fpRaw ? JSON.parse(c.fpRaw) : []);
      c.fp = [[...tokens(p.text)].join(' '), ...prev].slice(0, 5); c._sets = null;
      c.sk = [sketches({ posts: [p] }), ...(c.sk ? c.sk.split('|') : [])].slice(0, 5).join('|'); c._sk = undefined;
      if (c.bhk == null) c.bhk = ex.bhk;
      if (ex.rent && !c.rent) c.rent = ex.rent;
    }
  });

  // Replay merges into stored listings (one query to load them).
  const loaded = await db(() => repo.loadListings([...new Set(dbMerges.map(m => m[0]))]));
  for (const [id, s] of dbMerges) { const l = loaded.get(id); if (l) { cross(s.p.group || 'Group not detected', l.groups?.[0]); applyPost(l, s.p, s.ex, now); } }
  const changed = [...local.values(), ...loaded.values()];
  // AI extraction is a separate pass over ai_queue (src/ai.js), not part of ingest.
  const tDecide = performance.now();

  // 4. write (one batch), together with the run log / page progress so a resume never double-counts
  const runReport = mergeReports(opts.run?.report ? structuredClone(opts.run.report) : null, report);
  if (opts.datasetId) runReport.datasetId = opts.datasetId;
  const progress = typeof opts.run?.progress === 'function' ? opts.run.progress(prepared.groups) : opts.run?.progress;
  if (progress) runReport.progress = progress; else delete runReport.progress;
  // Area alerts: +1 statement in the same batch, only for brand-new listings from live sources (src/alerts.js).
  const extra = ingestAlertStatements({ source, sample: opts.sample, settings, newListings: [...local.values()], now });
  await db(() => repo.saveIngest({ listings: changed, keys: newKeys, mergedIds: [...loaded.keys()], run: { source, datasetId: opts.datasetId, status: opts.run?.status || 'done', report: runReport }, now, extra }));
  const t1 = performance.now();
  return {
    report, runReport, groups: prepared.groups, changed: changed.map(l => l.id),
    timings: { totalMs: t1 - t0, dbMs, jsMs: t1 - t0 - dbMs, screenMs: tScreen - t0, candidatesMs: tCand - t0, decideMs: tDecide - tCand, writeMs: t1 - tDecide, candidates: candRows.length },
  };
}
