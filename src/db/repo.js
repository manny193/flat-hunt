// Repository: every SQL statement the app runs lives here. Parameterised only.
// Bulk writes pass one JSON array parameter and expand it with json_each(), which keeps the
// statement count per ingest constant (D1 caps queries per invocation and params per query).

import { fingerprint, sketches } from '../core/logic.js';

const J = s => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const parseBhk = b => b == null ? null : /^\d+(\.\d+)?$/.test(b) ? Number(b) : b;
export const bhkKey = b => b == null || b === '' ? null : String(b);
const COLUMN_KEYS = ['id', 'status', 'stage', 'notes', 'hasUpdate', 'isSample', 'decidedAt', 'createdAt', 'updatedAt'];
export const STAGES = ['To call', 'Called – waiting', 'Visit booked', 'Visited', 'Negotiating', 'Token paid'];
export const STATUSES = ['new', 'approved', 'rejected'];

export function rowToListing(r) {
  const d = J(r.data) || {};
  return {
    ...d,
    id: r.id, status: r.status, stage: r.stage, notes: r.notes, kind: r.kind, bhk: parseBhk(r.bhk), rent: r.rent,
    hasUpdate: !!r.has_update, isSample: !!r.is_sample, areas: J(r.areas) || [], phones: J(r.phones) || [],
    firstPostedAt: r.first_posted_at, lastPostedAt: r.last_posted_at, decidedAt: r.decided_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function listingToRecord(l, now, writtenAt = now) {
  const data = {}; for (const [k, v] of Object.entries(l)) if (!COLUMN_KEYS.includes(k)) data[k] = v;
  return {
    id: l.id, kind: l.kind || 'offer', bhk: bhkKey(l.bhk), rent: l.rent || null, isSample: l.isSample ? 1 : 0,
    areas: JSON.stringify(l.areas || []), phones: JSON.stringify(l.phones || []), fp: JSON.stringify(fingerprint(l)), sk: sketches(l),
    first: l.firstPostedAt || l.lastPostedAt || now, last: l.lastPostedAt || now, created: l.createdAt || now, updated: writtenAt,
    data: JSON.stringify(data),
  };
}
/** Split items into JSON arrays of at most maxBytes each (D1 caps a single bound value at 2 MB). */
export function chunkJson(items, maxBytes = 400_000) {
  const out = []; let cur = [], size = 2;
  for (const it of items) {
    const s = JSON.stringify(it);
    if (cur.length && size + s.length + 1 > maxBytes) { out.push('[' + cur.join(',') + ']'); cur = []; size = 2; }
    cur.push(s); size += s.length + 1;
  }
  if (cur.length) out.push('[' + cur.join(',') + ']');
  return out;
}
const je = (path) => `json_extract(value,'$.${path}')`;

const UPSERT_LISTINGS = `INSERT INTO listings (id,status,stage,notes,kind,bhk,rent,has_update,is_sample,areas,phones,fp,sk,first_posted_at,last_posted_at,decided_at,created_at,updated_at,data)
SELECT ${je('id')},'new','','',${je('kind')},${je('bhk')},${je('rent')},0,${je('isSample')},${je('areas')},${je('phones')},${je('fp')},${je('sk')},${je('first')},${je('last')},NULL,${je('created')},${je('updated')},${je('data')}
FROM json_each(?) WHERE true
ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, bhk=excluded.bhk, rent=excluded.rent, areas=excluded.areas, phones=excluded.phones, fp=excluded.fp, sk=excluded.sk,
  first_posted_at=excluded.first_posted_at, last_posted_at=excluded.last_posted_at, updated_at=excluded.updated_at, data=excluded.data,
  has_update=CASE WHEN listings.status='approved' THEN 1 ELSE listings.has_update END`;
const DELETE_MATCH = `DELETE FROM listing_match WHERE listing_id IN (SELECT value FROM json_each(?))`;
const INSERT_MATCH = `INSERT OR REPLACE INTO listing_match (listing_id,area_id,kind,bhk,rent,last_posted_at)
SELECT ${je('l')},${je('a')},${je('k')},${je('b')},${je('r')},${je('t')} FROM json_each(?)`;
const INSERT_KEYS = `INSERT OR IGNORE INTO post_keys (key,listing_id) SELECT ${je('k')},${je('l')} FROM json_each(?)`;

// Candidate listings for fuzzy matching, one query for the whole batch.
// Each spec row: i (post index), a (area id, 0 = none), k (kind), b (bhk text|null), lo/hi (rent window|null).
// Three UNION ALL branches so SQLite can use the (area_id, kind, rent) index range for the common case.
// At most 100 most-recent candidates per post (reposts usually come within days).
const CANDIDATES = `WITH q AS MATERIALIZED (
  SELECT ${je('i')} AS qi, ${je('a')} AS area, ${je('k')} AS kind, ${je('b')} AS bhk, ${je('lo')} AS lo, ${je('hi')} AS hi FROM json_each(?)
), hits AS (
  SELECT q.qi, m.listing_id, m.last_posted_at, m.bhk AS mb, q.bhk AS qb FROM q JOIN listing_match m
    ON m.area_id = q.area AND m.kind = q.kind AND m.rent BETWEEN q.lo AND q.hi
    WHERE q.lo IS NOT NULL AND m.last_posted_at >= ?
  UNION ALL
  SELECT q.qi, m.listing_id, m.last_posted_at, m.bhk, q.bhk FROM q JOIN listing_match m
    ON m.area_id = q.area AND m.kind = q.kind AND m.rent IS NULL
    WHERE q.lo IS NOT NULL AND m.last_posted_at >= ?
  UNION ALL
  SELECT q.qi, m.listing_id, m.last_posted_at, m.bhk, q.bhk FROM q JOIN listing_match m
    ON m.area_id = q.area AND m.kind = q.kind
    WHERE q.lo IS NULL AND m.last_posted_at >= ?
), ranked AS (
  SELECT qi, listing_id, ROW_NUMBER() OVER (PARTITION BY qi ORDER BY last_posted_at DESC) AS rn
  FROM hits WHERE qb IS NULL OR mb IS NULL OR mb = qb
), cand AS (
  SELECT listing_id, group_concat(DISTINCT qi) AS qis FROM ranked WHERE rn <= 100 GROUP BY listing_id
)
SELECT l.id, l.kind, l.bhk, l.rent, l.phones, l.sk, l.areas, c.qis
FROM cand c CROSS JOIN listings l ON l.id = c.listing_id`;

export function createRepo(db) {
  return {
    db,
    // ---------- listings ----------
    async listListings({ status, area, since, sample } = {}) {
      const where = [], p = [];
      if (status) { where.push('status = ?'); p.push(status); }
      if (area != null) { where.push('id IN (SELECT listing_id FROM listing_match WHERE area_id = ?)'); p.push(area); }
      if (since != null) { where.push('updated_at > ?'); p.push(since); }
      if (sample) where.push('is_sample = 1');
      const rows = await db.all(`SELECT * FROM listings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY last_posted_at DESC LIMIT 5000`, p);
      return rows.map(rowToListing);
    },
    async listingIds() { return (await db.all('SELECT id FROM listings ORDER BY last_posted_at DESC LIMIT 5000')).map(r => r.id); },
    async getListing(id) { const r = await db.first('SELECT * FROM listings WHERE id = ?', [id]); return r ? rowToListing(r) : null; },
    async updateListingFields(id, f, now) {
      const r = await db.first(`UPDATE listings SET status = ?, stage = ?, notes = ?, decided_at = ?, has_update = ?, updated_at = ? WHERE id = ? RETURNING *`,
        [f.status, f.stage, f.notes, f.decidedAt ?? null, f.hasUpdate ? 1 : 0, now, id]);
      return r ? rowToListing(r) : null;
    },
    async deleteListings(ids) {
      if (!ids.length) return 0;
      const arr = JSON.stringify(ids);
      const res = await db.batch([
        { sql: 'DELETE FROM post_keys WHERE listing_id IN (SELECT value FROM json_each(?))', params: [arr] },
        { sql: DELETE_MATCH, params: [arr] },
        { sql: 'DELETE FROM listings WHERE id IN (SELECT value FROM json_each(?))', params: [arr] },
      ]);
      return res[2].changes;
    },
    async idsWhere({ status, sample }) {
      if (sample) return (await db.all('SELECT id FROM listings WHERE is_sample = 1')).map(r => r.id);
      return (await db.all('SELECT id FROM listings WHERE status = ?', [status])).map(r => r.id);
    },

    // ---------- ingest support ----------
    async lookupKeys(keys) {
      const m = new Map(); if (!keys.length) return m;
      for (const chunk of chunkJson(keys)) for (const r of await db.all('SELECT key, listing_id FROM post_keys WHERE key IN (SELECT value FROM json_each(?))', [chunk])) m.set(r.key, r.listing_id);
      return m;
    },
    async candidates(specs, since) {
      if (!specs.length) return [];
      const out = [];
      for (const chunk of chunkJson(specs)) out.push(...await db.all(CANDIDATES, [chunk, since, since, since]));
      // Token lists (fp) are not selected here: only candidates that pass the sketch prefilter need them.
      return out.map(r => ({ id: r.id, kind: r.kind, bhk: parseBhk(r.bhk), rent: r.rent, phones: J(r.phones) || [], fp: null, sk: r.sk, areas: J(r.areas) || [], qis: String(r.qis).split(',').map(Number) }));
    },
    async fingerprints(ids) {
      const m = new Map(); if (!ids.length) return m;
      for (const r of await db.all('SELECT id, fp FROM listings WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)])) m.set(r.id, r.fp);
      return m;
    },
    async loadListings(ids) {
      const m = new Map(); if (!ids.length) return m;
      for (const r of await db.all('SELECT * FROM listings WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)])) m.set(r.id, rowToListing(r));
      return m;
    },
    /** Persist one ingest atomically: listings (insert or merge), match index, post keys, run log. */
    async saveIngest({ listings, keys, run, now }) {
      // updated_at is the write time, not the ingest start: a long ingest (several dataset pages)
      // otherwise writes rows "in the past" that a client which synced meanwhile never fetches.
      const recs = listings.map(l => listingToRecord(l, now, Math.max(now, Date.now())));
      const match = [];
      for (const l of listings) for (const a of (l.areas && l.areas.length ? l.areas : [0])) match.push({ l: l.id, a, k: l.kind || 'offer', b: bhkKey(l.bhk), r: l.rent || null, t: l.lastPostedAt || now });
      const stmts = [];
      for (const c of chunkJson(recs)) stmts.push({ sql: UPSERT_LISTINGS, params: [c] });
      for (const c of chunkJson(listings.map(l => l.id))) stmts.push({ sql: DELETE_MATCH, params: [c] });
      for (const c of chunkJson(match)) stmts.push({ sql: INSERT_MATCH, params: [c] });
      for (const c of chunkJson(keys)) stmts.push({ sql: INSERT_KEYS, params: [c] });
      if (run) stmts.push(run.datasetId
        ? { sql: `UPDATE runs SET status = ?, at = ?, report = ? WHERE dataset_id = ?`, params: [run.status || 'done', now, JSON.stringify(run.report), run.datasetId] }
        : { sql: `INSERT INTO runs (source, status, at, report) VALUES (?, 'done', ?, ?)`, params: [run.source, now, JSON.stringify(run.report)] });
      await db.batch(stmts);
      return stmts.length;
    },

    // ---------- areas ----------
    async listAreas() {
      return (await db.all('SELECT * FROM areas ORDER BY created_at, id')).map(r => ({ id: r.id, name: r.name, keywords: J(r.keywords) || [], active: !!r.active, createdAt: r.created_at }));
    },
    async getArea(id) { const r = await db.first('SELECT * FROM areas WHERE id = ?', [id]); return r ? { id: r.id, name: r.name, keywords: J(r.keywords) || [], active: !!r.active, createdAt: r.created_at } : null; },
    async createArea({ name, keywords, active = true }, now) {
      const r = await db.first('INSERT INTO areas (name, keywords, active, created_at) VALUES (?, ?, ?, ?) RETURNING id', [name, JSON.stringify(keywords), active ? 1 : 0, now]);
      return this.getArea(r.id);
    },
    async updateArea(id, { name, keywords, active }) {
      await db.run('UPDATE areas SET name = ?, keywords = ?, active = ? WHERE id = ?', [name, JSON.stringify(keywords), active ? 1 : 0, id]);
      return this.getArea(id);
    },
    async deleteArea(id) {
      const res = await db.batch([
        { sql: 'DELETE FROM listing_match WHERE area_id = ?', params: [id] },
        { sql: 'DELETE FROM areas WHERE id = ?', params: [id] },
      ]);
      return res[1].changes > 0;
    },

    // ---------- settings ----------
    async getSettings() {
      const o = {}; for (const r of await db.all('SELECT key, value FROM settings')) o[r.key] = J(r.value);
      return o;
    },
    async putSettings(obj) {
      const stmts = Object.entries(obj).map(([k, v]) => ({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', params: [k, JSON.stringify(v)] }));
      await db.batch(stmts);
    },

    // ---------- runs ----------
    async listRuns(limit = 20) {
      return (await db.all('SELECT * FROM runs ORDER BY at DESC, id DESC LIMIT ?', [limit])).map(r => ({ id: r.id, source: r.source, datasetId: r.dataset_id, runId: r.run_id, status: r.status, startedAt: r.started_at, at: r.at, report: J(r.report) || {} }));
    },
    async recordStartedRun({ runId, datasetId, startedAt }) {
      await db.run(`INSERT OR IGNORE INTO runs (source, dataset_id, run_id, status, started_at, at, report) VALUES ('apify', ?, ?, 'running', ?, ?, '{}')`, [datasetId, runId, startedAt, startedAt]);
    },
    /** Take the ingest lock for a dataset. False when already ingested (or being ingested right now). */
    async claimRun({ datasetId, runId, startedAt, now }) {
      const r = await db.run(`INSERT INTO runs (source, dataset_id, run_id, status, started_at, at, report) VALUES ('apify', ?, ?, 'ingesting', ?, ?, '{}')
        ON CONFLICT(dataset_id) DO UPDATE SET status = 'ingesting', at = excluded.at,
          run_id = coalesce(runs.run_id, excluded.run_id), started_at = coalesce(runs.started_at, excluded.started_at)
        WHERE runs.status IN ('running', 'failed', 'partial') OR (runs.status = 'ingesting' AND runs.at < ?)`,
      [datasetId, runId ?? null, startedAt ?? null, now, now - 5 * 60e3]);
      return r.changes > 0;
    },
    /** Mark a dataset ingest failed but keep its saved page progress so the next attempt resumes. */
    async failRunKeepProgress(datasetId, error, now) {
      await db.run(`UPDATE runs SET status = 'failed', at = ?, report = json_set(CASE WHEN json_valid(report) THEN report ELSE '{}' END, '$.error', ?) WHERE dataset_id = ?`, [now, String(error).slice(0, 300), datasetId]);
    },
    async getRunByDataset(datasetId) {
      const r = await db.first('SELECT * FROM runs WHERE dataset_id = ?', [datasetId]);
      return r ? { id: r.id, source: r.source, datasetId: r.dataset_id, runId: r.run_id, status: r.status, startedAt: r.started_at, at: r.at, report: J(r.report) || {} } : null;
    },
    async lastIngestAt() {
      const r = await db.first(`SELECT max(at) AS t FROM runs WHERE source = 'apify' AND status = 'done'`);
      return r?.t ?? null;
    },
    async runStatuses(datasetIds) {
      const m = new Map(); if (!datasetIds.length) return m;
      for (const r of await db.all('SELECT dataset_id, status FROM runs WHERE dataset_id IN (SELECT value FROM json_each(?))', [JSON.stringify(datasetIds)])) m.set(r.dataset_id, r.status);
      return m;
    },
    async lastSuccessfulStart() {
      const r = await db.first(`SELECT max(started_at) AS t FROM runs WHERE source = 'apify' AND status = 'done' AND started_at IS NOT NULL`);
      return r?.t ?? null;
    },

    // ---------- login rate limit ----------
    /** Count one attempt for this IP (window resets after windowMs). Returns the count in the window. */
    async recordLoginFailure(ip, now, windowMs) {
      const r = await db.first(`INSERT INTO login_attempts (ip, fails, window_start) VALUES (?, 1, ?)
        ON CONFLICT(ip) DO UPDATE SET fails = CASE WHEN ? - window_start > ? THEN 1 ELSE fails + 1 END,
          window_start = CASE WHEN ? - window_start > ? THEN excluded.window_start ELSE window_start END
        RETURNING fails`, [ip, now, now, windowMs, now, windowMs]);
      return r?.fails ?? 1;
    },
    async clearLoginFailures(ip) { await db.run('DELETE FROM login_attempts WHERE ip = ?', [ip]); },
  };
}
