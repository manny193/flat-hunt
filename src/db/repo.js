// Repository: every SQL statement the app runs lives here. Parameterised only.
// Bulk writes pass one JSON array parameter and expand it with json_each(), which keeps the
// statement count per ingest constant (D1 caps queries per invocation and params per query).

import { fingerprint, sketches } from '../core/logic.js';

const J = s => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const parseBhk = b => b == null ? null : /^\d+(\.\d+)?$/.test(b) ? Number(b) : b;
export const bhkKey = b => b == null || b === '' ? null : String(b);
const COLUMN_KEYS = ['id', 'status', 'stage', 'notes', 'hasUpdate', 'isSample', 'decidedAt', 'createdAt', 'updatedAt', 'aiStatus', 'aiConfidence'];
export const STAGES = ['To call', 'Called – waiting', 'Visit booked', 'Visited', 'Negotiating', 'Token paid'];
export const STATUSES = ['new', 'approved', 'rejected'];

export function rowToListing(r) {
  const d = J(r.data) || {};
  return {
    ...d,
    id: r.id, status: r.status, stage: r.stage, notes: r.notes, kind: r.kind, bhk: parseBhk(r.bhk), rent: r.rent,
    hasUpdate: !!r.has_update, isSample: !!r.is_sample, areas: J(r.areas) || [], phones: J(r.phones) || [],
    firstPostedAt: r.first_posted_at, lastPostedAt: r.last_posted_at, decidedAt: r.decided_at, createdAt: r.created_at, updatedAt: r.updated_at,
    aiStatus: r.ai_status || '', aiConfidence: r.ai_confidence ?? null,
  };
}
// Per-user overlay: listings are shared; status/stage/notes/hasUpdate come from user_listing.
const UL_COLS = 'ul.status AS u_status, ul.stage AS u_stage, ul.notes AS u_notes, ul.has_update AS u_has_update, ul.decided_at AS u_decided_at, ul.updated_at AS u_updated_at';
// Listings a user sees: those in one of their areas, plus any they have decided on.
const VISIBLE = '(l.id IN (SELECT m.listing_id FROM listing_match m JOIN user_areas ua ON ua.area_id = m.area_id WHERE ua.user_id = ?) OR ul.listing_id IS NOT NULL)';
export function rowToUserListing(r) {
  const l = rowToListing(r);
  l.status = r.u_status || 'new'; l.stage = r.u_stage || ''; l.notes = r.u_notes || '';
  l.hasUpdate = !!r.u_has_update; l.decidedAt = r.u_decided_at ?? null;
  l.updatedAt = Math.max(r.updated_at || 0, r.u_updated_at || 0);
  return l;
}
export const rowToUser = r => r ? { id: r.id, email: r.email, name: r.name, picture: r.picture, role: r.role, status: r.status, createdAt: r.created_at, lastSeenAt: r.last_seen_at } : null;
const rowToRun = r => ({ id: r.id, source: r.source, datasetId: r.dataset_id, runId: r.run_id, status: r.status, startedAt: r.started_at, at: r.at, actor: r.actor ?? null, costUsd: r.cost_usd ?? null, finishedAt: r.finished_at ?? null, report: J(r.report) || {} });
const rowToArea = r => ({ id: r.id, name: r.name, keywords: J(r.keywords) || [], active: !!r.active, createdAt: r.created_at });
const rowToPrefs = r => r ? { enabled: !!r.enabled, quietStart: r.quiet_start, quietEnd: r.quiet_end, maxListings: r.max_listings, maxDigests: r.max_digests, minGapMin: r.min_gap_min, testAt: r.test_at ?? null } : null;
const bhkList = s => String(s || '').split(',').filter(Boolean);
// Push endpoints (address) and keys are never part of this shape: it is what the UI and admin see.
const rowToTarget = r => ({ id: r.id, channel: r.channel, label: r.label, createdAt: r.created_at, lastOkAt: r.last_ok_at ?? null, failures: r.failures, lastError: r.last_error ?? null });
function listingToRecord(l, now, writtenAt = now) {
  const data = {}; for (const [k, v] of Object.entries(l)) if (!COLUMN_KEYS.includes(k)) data[k] = v;
  return {
    id: l.id, kind: l.kind || 'offer', bhk: bhkKey(l.bhk), rent: l.rent || null, isSample: l.isSample ? 1 : 0,
    areas: JSON.stringify(l.areas || []), phones: JSON.stringify(l.phones || []), fp: JSON.stringify(fingerprint(l)), sk: sketches(l),
    first: l.firstPostedAt || l.lastPostedAt || now, last: l.lastPostedAt || now, created: l.createdAt || now, updated: writtenAt,
    data: JSON.stringify(data), ai: l.aiStatus || '', aic: l.aiConfidence ?? null,
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

// ai_status/ai_confidence: written only when src/ai.js produced something (non-empty aiStatus).
const UPSERT_LISTINGS = `INSERT INTO listings (id,status,stage,notes,kind,bhk,rent,has_update,is_sample,areas,phones,fp,sk,first_posted_at,last_posted_at,decided_at,created_at,updated_at,data,ai_status,ai_confidence)
SELECT ${je('id')},'new','','',${je('kind')},${je('bhk')},${je('rent')},0,${je('isSample')},${je('areas')},${je('phones')},${je('fp')},${je('sk')},${je('first')},${je('last')},NULL,${je('created')},${je('updated')},${je('data')},coalesce(${je('ai')},''),${je('aic')}
FROM json_each(?) WHERE true
ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, bhk=excluded.bhk, rent=excluded.rent, areas=excluded.areas, phones=excluded.phones, fp=excluded.fp, sk=excluded.sk,
  first_posted_at=excluded.first_posted_at, last_posted_at=excluded.last_posted_at, updated_at=excluded.updated_at, data=excluded.data,
  ai_status=CASE WHEN excluded.ai_status != '' THEN excluded.ai_status WHEN excluded.last_posted_at > listings.last_posted_at THEN '' ELSE listings.ai_status END,
  ai_confidence=CASE WHEN excluded.ai_status != '' THEN excluded.ai_confidence ELSE listings.ai_confidence END,
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
    // Without userId: the legacy global view (listings.status/stage/notes), used by ingest tests and
    // the reference pipeline. With userId: shared listings + that user's own state (user_listing).
    async listListings({ status, area, since, sample, userId } = {}) {
      if (userId != null) {
        const where = [VISIBLE], p = [userId, userId];
        if (status) { where.push("coalesce(ul.status, 'new') = ?"); p.push(status); }
        if (area != null) { where.push('l.id IN (SELECT listing_id FROM listing_match WHERE area_id = ?)'); p.push(area); }
        if (since != null) { where.push('(l.updated_at > ? OR ul.updated_at > ?)'); p.push(since, since); }
        if (sample) where.push('l.is_sample = 1');
        const rows = await db.all(`SELECT l.*, ${UL_COLS} FROM listings l LEFT JOIN user_listing ul ON ul.listing_id = l.id AND ul.user_id = ?
          WHERE ${where.join(' AND ')} ORDER BY l.last_posted_at DESC LIMIT 5000`, p);
        return rows.map(rowToUserListing);
      }
      const where = [], p = [];
      if (status) { where.push('status = ?'); p.push(status); }
      if (area != null) { where.push('id IN (SELECT listing_id FROM listing_match WHERE area_id = ?)'); p.push(area); }
      if (since != null) { where.push('updated_at > ?'); p.push(since); }
      if (sample) where.push('is_sample = 1');
      const rows = await db.all(`SELECT * FROM listings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY last_posted_at DESC LIMIT 5000`, p);
      return rows.map(rowToListing);
    },
    async listingIds(userId) {
      if (userId != null) return (await db.all(`SELECT l.id FROM listings l LEFT JOIN user_listing ul ON ul.listing_id = l.id AND ul.user_id = ? WHERE ${VISIBLE} ORDER BY l.last_posted_at DESC LIMIT 5000`, [userId, userId])).map(r => r.id);
      return (await db.all('SELECT id FROM listings ORDER BY last_posted_at DESC LIMIT 5000')).map(r => r.id);
    },
    async getListing(id, userId) {
      if (userId != null) { const r = await db.first(`SELECT l.*, ${UL_COLS} FROM listings l LEFT JOIN user_listing ul ON ul.listing_id = l.id AND ul.user_id = ? WHERE l.id = ?`, [userId, id]); return r ? rowToUserListing(r) : null; }
      const r = await db.first('SELECT * FROM listings WHERE id = ?', [id]); return r ? rowToListing(r) : null;
    },
    async updateListingFields(id, f, now, userId) {
      if (userId != null) {
        const r = await db.run(`INSERT INTO user_listing (user_id, listing_id, status, stage, notes, has_update, decided_at, updated_at)
          SELECT ?, id, ?, ?, ?, ?, ?, ? FROM listings WHERE id = ?
          ON CONFLICT(user_id, listing_id) DO UPDATE SET status = excluded.status, stage = excluded.stage, notes = excluded.notes,
            has_update = excluded.has_update, decided_at = excluded.decided_at, updated_at = excluded.updated_at`,
        [userId, f.status, f.stage, f.notes, f.hasUpdate ? 1 : 0, f.decidedAt ?? null, now, id]);
        return r.changes ? this.getListing(id, userId) : null;
      }
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
        { sql: 'DELETE FROM user_listing WHERE listing_id IN (SELECT value FROM json_each(?))', params: [arr] },
        { sql: 'DELETE FROM ai_queue WHERE listing_id IN (SELECT value FROM json_each(?))', params: [arr] },
      ]);
      return res[2].changes;
    },
    async idsWhere({ status, sample, userId }) {
      if (sample) return (await db.all('SELECT id FROM listings WHERE is_sample = 1')).map(r => r.id);
      if (userId != null) return (await db.all('SELECT listing_id AS id FROM user_listing WHERE user_id = ? AND status = ?', [userId, status])).map(r => r.id);
      return (await db.all('SELECT id FROM listings WHERE status = ?', [status])).map(r => r.id);
    },
    /** Public browse: newest offers in one area (or all), filtered, keyset-paginated by last_posted_at. */
    async publicListings({ area, bhk, maxRent, minRent, type, kind = 'offer', before, limit = 30 }) {
      const where = ['l.is_sample = 0'], p = [];
      // No area = every stored post in the city (all scraped groups are city-wide); an area narrows it.
      if (area != null) { where.push('l.id IN (SELECT listing_id FROM listing_match WHERE area_id = ?)'); p.push(area); }
      if (kind) { where.push('l.kind = ?'); p.push(kind); }
      if (bhk != null) { where.push('l.bhk = ?'); p.push(String(bhk)); }
      if (maxRent != null) { where.push('l.rent <= ?'); p.push(maxRent); }
      if (minRent != null) { where.push('l.rent >= ?'); p.push(minRent); }
      if (type) { where.push("json_extract(l.data, '$.type') = ?"); p.push(type); }
      if (before != null) { where.push('l.last_posted_at < ?'); p.push(before); }
      return (await db.all(`SELECT l.* FROM listings l WHERE ${where.join(' AND ')} ORDER BY l.last_posted_at DESC LIMIT ?`, [...p, limit])).map(rowToListing);
    },
    /** Admin search over post text, society and groups (LIKE; fine at this data size). */
    async searchListings({ q, area, limit = 50, offset = 0 }) {
      const where = [], p = [];
      if (q) { where.push("l.data LIKE ? ESCAPE '\\'"); p.push('%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%'); }
      if (area != null) { where.push('l.id IN (SELECT listing_id FROM listing_match WHERE area_id = ?)'); p.push(area); }
      const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const [rows, total] = await Promise.all([
        db.all(`SELECT l.*, (SELECT count(*) FROM user_listing u WHERE u.listing_id = l.id AND u.status = 'approved') AS shortlisted FROM listings l${w} ORDER BY l.last_posted_at DESC LIMIT ? OFFSET ?`, [...p, limit, offset]),
        db.first(`SELECT count(*) AS n FROM listings l${w}`, p),
      ]);
      return { total: total?.n ?? 0, listings: rows.map(r => ({ ...rowToListing(r), shortlistedBy: r.shortlisted })) };
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
    async saveIngest({ listings, keys, run, now, mergedIds = [], extra = [] }) {
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
      // A repost of a listing someone shortlisted flags it for them ("updated" badge).
      if (mergedIds.length) stmts.push({ sql: `UPDATE user_listing SET has_update = 1, updated_at = ? WHERE status = 'approved' AND listing_id IN (SELECT value FROM json_each(?))`, params: [Math.max(now, Date.now()), JSON.stringify(mergedIds)] });
      stmts.push(...extra);
      if (run) stmts.push(run.datasetId
        ? { sql: `UPDATE runs SET status = ?, at = ?, report = ?, finished_at = CASE WHEN ? = 'done' THEN ? ELSE finished_at END WHERE dataset_id = ?`, params: [run.status || 'done', now, JSON.stringify(run.report), run.status || 'done', Date.now(), run.datasetId] }
        : { sql: `INSERT INTO runs (source, status, started_at, at, finished_at, report) VALUES (?, 'done', ?, ?, ?, ?)`, params: [run.source, now, now, Date.now(), JSON.stringify(run.report)] });
      await db.batch(stmts);
      return stmts.length;
    },

    // ---------- areas ----------
    async listAreas() { return (await db.all('SELECT * FROM areas ORDER BY created_at, id')).map(rowToArea); },
    async getArea(id) { const r = await db.first('SELECT * FROM areas WHERE id = ?', [id]); return r ? rowToArea(r) : null; },
    async getAreaByName(name) { const r = await db.first('SELECT * FROM areas WHERE name = ? COLLATE NOCASE', [name]); return r ? rowToArea(r) : null; },
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
        { sql: 'DELETE FROM user_areas WHERE area_id = ?', params: [id] },
        { sql: 'DELETE FROM alert_areas WHERE area_id = ?', params: [id] },
      ]);
      return res[1].changes > 0;
    },
    /** Merge area `from` into `to`: keywords, match index, listings' area lists and users' picks move over. */
    async mergeAreas(from, to, keywords) {
      await db.batch([
        { sql: 'UPDATE areas SET keywords = ? WHERE id = ?', params: [JSON.stringify(keywords), to] },
        { sql: 'INSERT OR IGNORE INTO listing_match (listing_id, area_id, kind, bhk, rent, last_posted_at) SELECT listing_id, ?, kind, bhk, rent, last_posted_at FROM listing_match WHERE area_id = ?', params: [to, from] },
        { sql: 'DELETE FROM listing_match WHERE area_id = ?', params: [from] },
        { sql: `UPDATE listings SET areas = (SELECT json_group_array(v) FROM (SELECT DISTINCT CASE WHEN value = ? THEN ? ELSE value END AS v FROM json_each(listings.areas)))
                WHERE EXISTS (SELECT 1 FROM json_each(listings.areas) WHERE value = ?)`, params: [from, to, from] },
        { sql: 'INSERT OR IGNORE INTO user_areas (user_id, area_id, created_at) SELECT user_id, ?, created_at FROM user_areas WHERE area_id = ?', params: [to, from] },
        { sql: 'DELETE FROM user_areas WHERE area_id = ?', params: [from] },
        { sql: 'INSERT OR IGNORE INTO alert_areas (user_id, area_id, max_rent, bhks, created_at) SELECT user_id, ?, max_rent, bhks, created_at FROM alert_areas WHERE area_id = ?', params: [to, from] },
        { sql: 'DELETE FROM alert_areas WHERE area_id = ?', params: [from] },
        { sql: 'DELETE FROM areas WHERE id = ?', params: [from] },
      ]);
      return this.getArea(to);
    },
    /** Admin view: per area, listings matched (all time / last 7 days) and users following it. */
    async areaStats(now) {
      const rows = await db.all(`SELECT a.*, (SELECT count(*) FROM listing_match m WHERE m.area_id = a.id) AS listings,
          (SELECT count(*) FROM listing_match m WHERE m.area_id = a.id AND m.last_posted_at >= ?) AS recent,
          (SELECT count(*) FROM user_areas u WHERE u.area_id = a.id) AS users
        FROM areas a ORDER BY a.created_at, a.id`, [now - 7 * 864e5]);
      return rows.map(r => ({ ...rowToArea(r), listings: r.listings, listings7d: r.recent, users: r.users }));
    },
    async maxListingRowid() { return (await db.first('SELECT max(rowid) AS m FROM listings'))?.m ?? 0; },
    /**
     * Area backfill for one rowid range: tag stored listings whose text contains one of the LIKE
     * patterns with the area (match index + listings.areas), and bump updated_at so open apps see them.
     * The text scan runs inside SQLite, so it costs D1 rows read, not Worker CPU.
     */
    async backfillChunk(areaId, patterns, from, to, now) {
      if (!patterns.length) return 0;
      const like = patterns.map(() => "data LIKE ? ESCAPE '\\'").join(' OR ');
      const sel = `SELECT id FROM listings WHERE rowid > ? AND rowid <= ? AND (${like})`;
      const res = await db.batch([
        { sql: `INSERT OR IGNORE INTO listing_match (listing_id, area_id, kind, bhk, rent, last_posted_at) SELECT id, ?, kind, bhk, rent, last_posted_at FROM listings WHERE id IN (${sel})`, params: [areaId, from, to, ...patterns] },
        { sql: `UPDATE listings SET areas = json_insert(areas, '$[#]', ?), updated_at = ? WHERE id IN (${sel}) AND NOT EXISTS (SELECT 1 FROM json_each(listings.areas) WHERE value = ?)`, params: [areaId, now, from, to, ...patterns, areaId] },
        { sql: `DELETE FROM listing_match WHERE area_id = 0 AND listing_id IN (SELECT listing_id FROM listing_match WHERE area_id = ?)`, params: [areaId] },
      ]);
      return res[0].changes;
    },
    async listUserAreas(userId) {
      return (await db.all('SELECT a.* FROM areas a JOIN user_areas u ON u.area_id = a.id WHERE u.user_id = ? ORDER BY u.created_at, a.id', [userId])).map(rowToArea);
    },
    async linkArea(userId, areaId, now) { return (await db.run('INSERT OR IGNORE INTO user_areas (user_id, area_id, created_at) VALUES (?, ?, ?)', [userId, areaId, now])).changes > 0; },
    // Unfollowing an area also stops its alerts.
    async unlinkArea(userId, areaId) {
      const res = await db.batch([
        { sql: 'DELETE FROM user_areas WHERE user_id = ? AND area_id = ?', params: [userId, areaId] },
        { sql: 'DELETE FROM alert_areas WHERE user_id = ? AND area_id = ?', params: [userId, areaId] },
      ]);
      return res[0].changes > 0;
    },

    // ---------- users ----------
    async getUser(id) { return rowToUser(await db.first('SELECT * FROM users WHERE id = ?', [id])); },
    async getUserByEmail(email) { return rowToUser(await db.first('SELECT * FROM users WHERE email = ?', [email])); },
    /**
     * Sign-in upsert. New rows get `status`; existing rows keep theirs (an admin decision), except that an
     * env admin (role 'admin' passed in) is always active and admin. Profile fields refresh every sign-in.
     */
    async upsertUser({ email, name = '', picture = '', role = 'user', status = 'active' }, now) {
      return rowToUser(await db.first(`INSERT INTO users (email, name, picture, role, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
          picture = CASE WHEN excluded.picture != '' THEN excluded.picture ELSE users.picture END,
          role = CASE WHEN excluded.role = 'admin' THEN 'admin' ELSE users.role END,
          status = CASE WHEN excluded.role = 'admin' THEN 'active' ELSE users.status END,
          last_seen_at = excluded.last_seen_at
        RETURNING *`, [email, String(name).slice(0, 120), String(picture).slice(0, 500), role, status, now, now]));
    },
    async touchUser(id, now) { await db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now, id]); },
    async listUsers() {
      return (await db.all(`SELECT u.*, (SELECT count(*) FROM user_listing x WHERE x.user_id = u.id AND x.status = 'approved') AS shortlisted,
          (SELECT count(*) FROM user_areas a WHERE a.user_id = u.id) AS areas FROM users u ORDER BY u.created_at, u.id`)).map(r => ({ ...rowToUser(r), shortlisted: r.shortlisted, areas: r.areas }));
    },
    async updateUser(id, { role, status }) {
      return rowToUser(await db.first('UPDATE users SET role = coalesce(?, role), status = coalesce(?, status) WHERE id = ? RETURNING *', [role ?? null, status ?? null, id]));
    },
    /**
     * Give the pre-accounts global state (listings.status/stage/notes, every area) to one admin, once.
     * The settings row is the once-only latch, so concurrent first logins can't both copy.
     */
    async adoptLegacyState(userId, now) {
      const latch = await db.run(`INSERT INTO settings (key, value) VALUES ('legacyStateOwner', ?) ON CONFLICT(key) DO NOTHING`, [JSON.stringify({ userId, at: now })]);
      if (!latch.changes) {
        // The break-glass password used before ADMIN_EMAILS was set signs in as a placeholder account
        // (break-glass@flat-hunt.invalid). If that placeholder took the legacy state, hand a copy of it
        // to the first real admin account, so the founder's areas and decisions follow him (QA).
        const owner = await db.first(`SELECT u.id, u.email FROM settings s JOIN users u ON u.id = json_extract(s.value, '$.userId') WHERE s.key = 'legacyStateOwner'`);
        if (!owner || owner.id === userId || !/@flat-hunt\.invalid$/i.test(owner.email)) return false;
        await db.batch([
          { sql: `INSERT OR IGNORE INTO user_listing (user_id, listing_id, status, stage, notes, has_update, decided_at, updated_at)
                  SELECT ?, listing_id, status, stage, notes, has_update, decided_at, ? FROM user_listing WHERE user_id = ?`, params: [userId, now, owner.id] },
          { sql: 'INSERT OR IGNORE INTO user_areas (user_id, area_id, created_at) SELECT ?, area_id, created_at FROM user_areas WHERE user_id = ?', params: [userId, owner.id] },
          { sql: `UPDATE settings SET value = ? WHERE key = 'legacyStateOwner'`, params: [JSON.stringify({ userId, at: now, from: owner.id })] },
        ]);
        return true;
      }
      await db.batch([
        { sql: `INSERT OR IGNORE INTO user_listing (user_id, listing_id, status, stage, notes, has_update, decided_at, updated_at)
                SELECT ?, id, status, stage, notes, has_update, decided_at, ? FROM listings WHERE status != 'new' OR stage != '' OR notes != ''`, params: [userId, now] },
        { sql: 'INSERT OR IGNORE INTO user_areas (user_id, area_id, created_at) SELECT ?, id, created_at FROM areas', params: [userId] },
      ]);
      return true;
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

    /** Database size in bytes (one statement), or null where the platform does not allow page-count pragmas. */
    async dbSizeBytes() {
      try { const r = await db.first('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()'); return Number.isFinite(Number(r?.size)) ? Number(r.size) : null; } catch { return null; }
    },

    // ---------- runs ----------
    async listRuns(limit = 20, { source } = {}) {
      const rows = source
        ? await db.all('SELECT * FROM runs WHERE source = ? ORDER BY at DESC, id DESC LIMIT ?', [source, limit])
        : await db.all('SELECT * FROM runs ORDER BY at DESC, id DESC LIMIT ?', [limit]);
      return rows.map(rowToRun);
    },
    async runsSince(t, limit = 1000) { return (await db.all('SELECT * FROM runs WHERE at >= ? ORDER BY at LIMIT ?', [t, limit])).map(rowToRun); },
    async recordStartedRun({ runId, datasetId, startedAt, actor = null, caps = null }) {
      await db.run(`INSERT OR IGNORE INTO runs (source, dataset_id, run_id, status, started_at, at, report, actor) VALUES ('apify', ?, ?, 'running', ?, ?, ?, ?)`, [datasetId, runId, startedAt, startedAt, JSON.stringify(caps ? { caps } : {}), actor]);
    },
    async createRun({ source, datasetId, startedAt, actor = null }) {
      await db.run(`INSERT OR IGNORE INTO runs (source, dataset_id, status, started_at, at, report, actor) VALUES (?, ?, 'ingesting', ?, ?, '{}', ?)`, [source, datasetId, startedAt, startedAt, actor]);
    },
    async finishRun(datasetId, { status = 'done', report, now }) {
      await db.run('UPDATE runs SET status = ?, at = ?, finished_at = ?, report = ? WHERE dataset_id = ?', [status, now, Date.now(), JSON.stringify(report || {}), datasetId]);
    },
    /** After ingest: store cost (column + report.cost breakdown) and whether the run hit its limits (report.truncated). */
    async annotateRun(datasetId, { costUsd = null, cost = null, truncated = null }) {
      await db.run(`UPDATE runs SET cost_usd = coalesce(?, cost_usd), report = json_set(json_set(coalesce(report, '{}'), '$.cost', json(?)), '$.truncated', json(?)) WHERE dataset_id = ?`,
        [costUsd, JSON.stringify(cost), JSON.stringify(truncated), datasetId]);
    },
    /** Latest successfully ingested Apify run: when it started and whether it was cut short. */
    async lastGoodRun() {
      const r = await db.first(`SELECT started_at, json_extract(report, '$.truncated') AS tr FROM runs WHERE source = 'apify' AND status = 'done' AND started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`);
      return r ? { startedAt: r.started_at, truncated: J(r.tr) } : null;
    },
    /** Store a run's cost; the breakdown (platform, per-row charges, rows) goes into report.cost. */
    async setRunCost(datasetId, costUsd, breakdown = null) {
      if (breakdown) await db.run(`UPDATE runs SET cost_usd = ?, report = json_set(coalesce(report, '{}'), '$.cost', json(?)) WHERE dataset_id = ?`, [costUsd, JSON.stringify(breakdown), datasetId]);
      else await db.run('UPDATE runs SET cost_usd = ? WHERE dataset_id = ?', [costUsd, datasetId]);
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
      return r ? rowToRun(r) : null;
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
    /** Fixed-window counter (one atomic upsert). Returns the count in the current window. */
    async hitRate(key, now, windowMs) {
      const r = await db.first(`INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
          window_start = CASE WHEN ? - window_start >= ? THEN excluded.window_start ELSE window_start END
        RETURNING count`, [key, now, now, windowMs, now, windowMs]);
      return r?.count ?? 1;
    },

    // ---------- AI extraction queue ----------
    /** Queue newest posts of listings that nobody has had read yet, only in areas someone follows. */
    async aiEnqueue(now, sinceMs, limit = 50) {
      return (await db.run(`INSERT OR IGNORE INTO ai_queue (post_id, listing_id, status, attempts, next_at, created_at, updated_at)
        SELECT json_extract(l.data, '$.posts[0].id'), l.id, 'pending', 0, ?, ?, ? FROM listings l
        WHERE l.ai_status = '' AND l.is_sample = 0 AND l.last_posted_at >= ? AND json_extract(l.data, '$.posts[0].id') IS NOT NULL
          AND l.id IN (SELECT m.listing_id FROM listing_match m JOIN user_areas ua ON ua.area_id = m.area_id)
        ORDER BY l.last_posted_at DESC LIMIT ?`, [now, now, now, sinceMs, limit])).changes;
    },
    async aiDue(now, limit) {
      return db.all(`SELECT q.post_id, q.listing_id, q.attempts FROM ai_queue q WHERE q.status IN ('pending','retry') AND q.next_at <= ? ORDER BY q.created_at LIMIT ?`, [now, limit]);
    },
    async aiStats(now) {
      const [byStatus, byListing, hist, failures, today] = await Promise.all([
        db.all('SELECT status, count(*) AS n FROM ai_queue GROUP BY status'),
        db.all("SELECT ai_status AS s, count(*) AS n FROM listings GROUP BY ai_status"),
        db.all("SELECT min(9, CAST(confidence * 10 AS INTEGER)) AS bin, count(*) AS n FROM ai_queue WHERE status = 'done' AND confidence IS NOT NULL AND updated_at >= ? GROUP BY bin", [now - 30 * 864e5]),
        db.all(`SELECT q.post_id, q.listing_id, q.error, q.attempts, q.updated_at, substr(json_extract(l.data, '$.posts[0].text'), 1, 160) AS excerpt
                FROM ai_queue q LEFT JOIN listings l ON l.id = q.listing_id WHERE q.status = 'failed' OR (q.status = 'retry' AND q.error IS NOT NULL) ORDER BY q.updated_at DESC LIMIT 30`),
        db.first("SELECT count(*) AS n, avg(confidence) AS avg FROM ai_queue WHERE status = 'done' AND updated_at >= ?", [now - (now % 864e5)]),
      ]);
      const median = await db.first("SELECT confidence AS c FROM ai_queue WHERE status = 'done' AND confidence IS NOT NULL ORDER BY confidence LIMIT 1 OFFSET (SELECT count(*) / 2 FROM ai_queue WHERE status = 'done' AND confidence IS NOT NULL)");
      return { byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.n])), byListing: Object.fromEntries(byListing.map(r => [r.s || 'none', r.n])), histogram: Array.from({ length: 10 }, (_, i) => hist.find(h => h.bin === i)?.n || 0), failures, processedToday: today?.n || 0, medianConfidence: median?.c ?? null };
    },
    async aiRetry(postId, now) { return (await db.run("UPDATE ai_queue SET status = 'pending', attempts = 0, next_at = ?, error = NULL, updated_at = ? WHERE post_id = ?", [now, now, postId])).changes > 0; },
    async listSuggestions(status = 'open', limit = 50) {
      return db.all(`SELECT s.*, a.rent AS a_rent, a.bhk AS a_bhk, b.rent AS b_rent, b.bhk AS b_bhk, substr(json_extract(a.data, '$.posts[0].text'), 1, 140) AS a_text, substr(json_extract(b.data, '$.posts[0].text'), 1, 140) AS b_text
        FROM merge_suggestions s JOIN listings a ON a.id = s.a JOIN listings b ON b.id = s.b WHERE s.status = ? ORDER BY s.created_at DESC LIMIT ?`, [status, limit]);
    },
    async getSuggestion(id) { return db.first('SELECT * FROM merge_suggestions WHERE id = ?', [id]); },
    async setSuggestion(id, status) { await db.run('UPDATE merge_suggestions SET status = ? WHERE id = ?', [status, id]); },
    /** Listings that could be the same flat as one whose BHK/rent the AI just changed. */
    async lookalikes(id, areas, kind, bhk, lo, hi) {
      const a = areas && areas.length ? areas : [0];
      return (await db.all(`SELECT DISTINCT l.* FROM listing_match m JOIN listings l ON l.id = m.listing_id
        WHERE m.area_id IN (SELECT value FROM json_each(?)) AND m.kind = ? AND m.bhk = ? AND m.rent BETWEEN ? AND ? AND m.listing_id != ? LIMIT 5`,
      [JSON.stringify(a), kind, bhk, lo, hi, id])).map(rowToListing);
    },
    /** Fold listing `from` into `into` (already updated in memory): posts, keys, user state move over. */
    mergeStatements(fromId, intoId) {
      return [
        { sql: 'UPDATE OR IGNORE post_keys SET listing_id = ? WHERE listing_id = ?', params: [intoId, fromId] },
        { sql: `INSERT OR IGNORE INTO user_listing (user_id, listing_id, status, stage, notes, has_update, decided_at, updated_at) SELECT user_id, ?, status, stage, notes, has_update, decided_at, updated_at FROM user_listing WHERE listing_id = ?`, params: [intoId, fromId] },
        { sql: 'DELETE FROM user_listing WHERE listing_id = ?', params: [fromId] },
        { sql: 'DELETE FROM listing_match WHERE listing_id = ?', params: [fromId] },
        { sql: 'DELETE FROM post_keys WHERE listing_id = ?', params: [fromId] },
        { sql: 'DELETE FROM ai_queue WHERE listing_id = ?', params: [fromId] },
        { sql: 'DELETE FROM listings WHERE id = ?', params: [fromId] },
      ];
    },

    // ---------- area alerts (src/alerts.js, docs/ai/ALERTS-WEBPUSH.md) ----------
    async alertPrefs(userId) { return rowToPrefs(await db.first('SELECT * FROM alert_prefs WHERE user_id = ?', [userId])); },
    /** Upsert a user's alert settings (all fields; callers merge with the current row first). */
    async putAlertPrefs(userId, p, now) {
      await db.run(`INSERT INTO alert_prefs (user_id, enabled, quiet_start, quiet_end, max_listings, max_digests, min_gap_min, test_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, max_listings = excluded.max_listings,
          max_digests = excluded.max_digests, min_gap_min = excluded.min_gap_min, test_at = excluded.test_at, updated_at = excluded.updated_at`,
      [userId, p.enabled ? 1 : 0, p.quietStart, p.quietEnd, p.maxListings, p.maxDigests, p.minGapMin, p.testAt ?? null, now, now]);
      return this.alertPrefs(userId);
    },
    async alertAreas(userId) {
      return (await db.all('SELECT aa.*, a.name FROM alert_areas aa JOIN areas a ON a.id = aa.area_id WHERE aa.user_id = ? ORDER BY aa.created_at, aa.area_id', [userId]))
        .map(r => ({ areaId: r.area_id, name: r.name, maxRent: r.max_rent ?? null, bhks: bhkList(r.bhks) }));
    },
    /**
     * Replace a user's alert areas (full set) in one batch. Only followed areas are kept (the API checks
     * first and answers 400). Creates alert_prefs with `defaults` when the user has none yet.
     */
    async replaceAlertAreas(userId, areas, now, defaults) {
      const rows = JSON.stringify(areas.map(a => ({ a: a.areaId, r: a.maxRent ?? null, b: a.bhks?.length ? ',' + a.bhks.join(',') + ',' : '' })));
      await db.batch([
        { sql: 'DELETE FROM alert_areas WHERE user_id = ?', params: [userId] },
        { sql: `INSERT OR IGNORE INTO alert_areas (user_id, area_id, max_rent, bhks, created_at) SELECT ?, ${je('a')}, ${je('r')}, ${je('b')}, ? FROM json_each(?)
                WHERE ${je('a')} IN (SELECT area_id FROM user_areas WHERE user_id = ?)`, params: [userId, now, rows, userId] },
        { sql: `INSERT OR IGNORE INTO alert_prefs (user_id, enabled, quiet_start, quiet_end, max_listings, max_digests, min_gap_min, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          params: [userId, defaults.quietStart, defaults.quietEnd, defaults.maxListings, defaults.maxDigests, defaults.minGapMin, now, now] },
      ]);
      return this.alertAreas(userId);
    },
    async alertTargets(userId) { return (await db.all('SELECT * FROM alert_targets WHERE user_id = ? ORDER BY id', [userId])).map(rowToTarget); },
    /** Targets to push to (with address). Internal: only the send step and the test send use it. */
    async alertTargetsForSend(userIds) {
      if (!userIds.length) return [];
      return db.all('SELECT id, user_id, channel, address FROM alert_targets WHERE user_id IN (SELECT value FROM json_each(?)) AND failures < 5 ORDER BY user_id, id', [JSON.stringify(userIds)]);
    },
    /**
     * Store a device. An endpoint already stored (maybe for another account on the same device) moves to
     * this user and is reset. At most `max` targets per user: the least recently updated ones go.
     */
    async upsertAlertTarget({ userId, channel, address, keys, label }, now, max = 5) {
      await db.batch([
        { sql: `INSERT INTO alert_targets (user_id, channel, address, keys, label, failures, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(channel, address) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, label = excluded.label, failures = 0, last_error = NULL, updated_at = excluded.updated_at`,
          params: [userId, channel, address, JSON.stringify(keys || {}), label || '', now, now] },
        { sql: 'DELETE FROM alert_targets WHERE user_id = ? AND id NOT IN (SELECT id FROM alert_targets WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)', params: [userId, userId, max] },
      ]);
      return (await db.first('SELECT id FROM alert_targets WHERE channel = ? AND address = ?', [channel, address]))?.id ?? null;
    },
    async deleteAlertTarget(userId, id) { return (await db.run('DELETE FROM alert_targets WHERE id = ? AND user_id = ?', [id, userId])).changes > 0; },
    /**
     * Send step, one query: users with pending alerts (active accounts, alerts not paused), oldest first,
     * with their caps and today's counts (dayStart = IST midnight). Role and email decide the admin-only soft launch.
     */
    async alertDueUsers(dayStart, limit = 60) {
      return db.all(`SELECT q.user_id, COUNT(*) AS pending, MIN(q.created_at) AS oldest,
          p.quiet_start, p.quiet_end, p.max_listings, p.max_digests, p.min_gap_min, u.role, u.email,
          (SELECT COUNT(*) FROM alert_queue s WHERE s.user_id = q.user_id AND s.status = 'sent' AND s.sent_at >= ?) AS sent_today,
          (SELECT COUNT(DISTINCT sent_at) FROM alert_queue s WHERE s.user_id = q.user_id AND s.status = 'sent' AND s.sent_at >= ?) AS digests_today,
          (SELECT MAX(sent_at) FROM alert_queue s WHERE s.user_id = q.user_id AND s.status = 'sent') AS last_sent
        FROM alert_queue q
        JOIN alert_prefs p ON p.user_id = q.user_id AND p.enabled = 1
        JOIN users u ON u.id = q.user_id AND u.status = 'active'
        WHERE q.status = 'pending'
        GROUP BY q.user_id ORDER BY oldest, q.user_id LIMIT ?`, [dayStart, dayStart, limit]);
    },
    /**
     * Send step write-back, one batch of at most 6 statements: expire old pending rows, mark sent
     * (sent_at = batch id), mark not pushed (over the cap or no working device), delete gone devices, count
     * failures (per-target error code), reset devices that worked. Empty parts are left out.
     */
    async alertWriteBack({ now, sentUsers = [], cappedUsers = [], expireBefore, goneIds = [], failed = [], okIds = [] }) {
      const j = a => JSON.stringify(a);
      const stmts = [];
      // Expire first, so a digest never claims rows older than the expiry window.
      if (expireBefore != null) stmts.push({ sql: "UPDATE alert_queue SET status = 'expired' WHERE status = 'pending' AND created_at < ?", params: [expireBefore] });
      if (sentUsers.length) stmts.push({ sql: "UPDATE alert_queue SET status = 'sent', sent_at = ? WHERE status = 'pending' AND created_at <= ? AND user_id IN (SELECT value FROM json_each(?))", params: [now, now, j(sentUsers)] });
      if (cappedUsers.length) stmts.push({ sql: "UPDATE alert_queue SET status = 'capped' WHERE status = 'pending' AND created_at <= ? AND user_id IN (SELECT value FROM json_each(?))", params: [now, j(cappedUsers)] });
      if (goneIds.length) stmts.push({ sql: 'DELETE FROM alert_targets WHERE id IN (SELECT value FROM json_each(?))', params: [j(goneIds)] });
      if (failed.length) stmts.push({ sql: `UPDATE alert_targets SET failures = failures + 1, updated_at = ?,
          last_error = (SELECT ${je('e')} FROM json_each(?) WHERE ${je('i')} = alert_targets.id)
          WHERE id IN (SELECT ${je('i')} FROM json_each(?))`, params: [now, j(failed.map(f => ({ i: f.id, e: f.error }))), j(failed.map(f => ({ i: f.id })))] });
      if (okIds.length) stmts.push({ sql: 'UPDATE alert_targets SET failures = 0, last_error = NULL, last_ok_at = ? WHERE id IN (SELECT value FROM json_each(?))', params: [now, j(okIds)] });
      if (stmts.length) await db.batch(stmts);
      return stmts.length;
    },

    // ---------- retention ----------
    /**
     * Delete listings last posted before `cutoff` (and their keys, match rows and user rows) unless
     * someone shortlisted them. At most `max` per call, oldest first; also clears stale rate-limit rows.
     */
    async purgeOld(cutoff, now, max = 500) {
      const sel = `SELECT id FROM listings WHERE last_posted_at < ? AND status != 'approved'
        AND id NOT IN (SELECT listing_id FROM user_listing WHERE status = 'approved') ORDER BY last_posted_at, id LIMIT ?`;
      const res = await db.batch([
        { sql: `DELETE FROM post_keys WHERE listing_id IN (${sel})`, params: [cutoff, max] },
        { sql: `DELETE FROM listing_match WHERE listing_id IN (${sel})`, params: [cutoff, max] },
        { sql: `DELETE FROM user_listing WHERE listing_id IN (${sel})`, params: [cutoff, max] },
        { sql: `DELETE FROM ai_queue WHERE listing_id IN (${sel})`, params: [cutoff, max] },
        { sql: `DELETE FROM listings WHERE id IN (${sel})`, params: [cutoff, max] },
        { sql: 'DELETE FROM rate_limits WHERE window_start < ?', params: [now - 864e5] },
        { sql: 'DELETE FROM login_attempts WHERE window_start < ?', params: [now - 864e5] },
        // Area alerts: the queue keeps 7 days (the #alerts screen), dead devices go after a week of failures.
        { sql: 'DELETE FROM alert_queue WHERE created_at < ?', params: [now - 7 * 864e5] },
        { sql: 'DELETE FROM alert_targets WHERE failures >= 5 AND updated_at < ?', params: [now - 7 * 864e5] },
      ]);
      return res[4].changes;
    },
  };
}
