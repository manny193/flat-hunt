// Area alerts over Web Push (docs/ai/ALERTS-WEBPUSH.md). Payload-less: the push carries nothing; the
// service worker (web/sw.js) fetches the notification text from GET /api/alerts/inbox with the session
// cookie, so listing details never pass through Google, Mozilla or Apple and the role is re-checked at
// display time. This module holds the ingest enqueue statement, the user and admin API, the cron send
// step and the notification text builder.
import { HttpError, json, errorJson, readJson } from './http.js';
import { channels } from './channels/index.js';

const HOUR = 36e5;
const DAY = 24 * HOUR;
const IST = 5.5 * HOUR;

// settings.alerts: admin switches and the defaults new users get. Soft launch: off, and admins only.
// maxListings / maxDigests here also cap what a user may pick for themselves.
export const ALERT_DEFAULTS = { enabled: false, adminOnly: true, maxPushesPerDay: 2000, quietStart: 22, quietEnd: 8, maxListings: 30, maxDigests: 6, minGapMin: 60 };
export const alertsConfig = settings => ({ ...ALERT_DEFAULTS, ...(settings?.alerts && typeof settings.alerts === 'object' ? settings.alerts : {}) });
// Only fresh posts from live sources alert. Imports, samples and pasted posts never do.
export const LIVE_SOURCES = ['apify', 'reddit', 'phone'];
const ENQUEUE_MAX_AGE = DAY; // datasets carry a few days of backfill: only posts from the last 24 h alert

/**
 * One statement, appended to the ingest batch after the listing_match rewrite: queue each brand-new
 * listing for every user who alerts on one of its areas and whose filters it passes. Offers only
 * (no "looking for" posts), area 0 (no area) never alerts, and merged reposts are not in newIds.
 * The (user_id, listing_id) key dedupes a listing in two of a user's areas and repeated ingests.
 */
export function enqueueStatement(newIds, now) {
  return {
    sql: `INSERT OR IGNORE INTO alert_queue (user_id, listing_id, area_id, status, created_at)
      SELECT a.user_id, m.listing_id, MIN(m.area_id), 'pending', ?
      FROM listing_match m
      JOIN alert_areas a ON a.area_id = m.area_id
      JOIN alert_prefs p ON p.user_id = a.user_id AND p.enabled = 1
      WHERE m.listing_id IN (SELECT value FROM json_each(?))
        AND m.area_id != 0
        AND m.kind = 'offer'
        AND m.last_posted_at >= ?
        AND (a.max_rent IS NULL OR m.rent IS NULL OR m.rent <= a.max_rent)
        AND (a.bhks = '' OR m.bhk IS NULL OR instr(a.bhks, ',' || m.bhk || ',') > 0)
      GROUP BY a.user_id, m.listing_id`,
    params: [now, JSON.stringify(newIds), now - ENQUEUE_MAX_AGE],
  };
}

/** Statements ingestItems() adds to its write batch: none unless alerts are on and the source is live. */
export function ingestAlertStatements({ source, sample, settings, newListings, now }) {
  if (sample || !LIVE_SOURCES.includes(source) || !alertsConfig(settings).enabled) return [];
  const ids = newListings.filter(l => !l.isSample).map(l => l.id);
  return ids.length ? [enqueueStatement(ids, now)] : [];
}

// ---------- user API: /api/alerts/* ----------
export const MAX_ALERT_AREAS = 10;
export const MAX_TARGETS = 5;
// bhkKey values a filter can hold (listing_match.bhk). The UI's "4+" chip sends 4, 4.5, 5 and 6.
export const BHK_VALUES = ['1RK', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5', '6'];
const KB = 1024;

export const vapidConfigured = env => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
/** Why this caller cannot use alerts right now, or null. Admin switch, VAPID secrets, soft launch. */
export function alertsBlocked(cfg, env, role) {
  if (!vapidConfigured(env)) return 'not_configured';
  if (!cfg.enabled) return 'off';
  if (cfg.adminOnly && role !== 'admin') return 'admin_only';
  return null;
}
const BLOCKED_MSG = { not_configured: 'Alerts are not set up on this server yet.', off: 'Alerts are switched off right now.', admin_only: 'Alerts are being tested by admins first. They open to everyone soon.' };
const defaultPrefs = cfg => ({ enabled: true, quietStart: cfg.quietStart, quietEnd: cfg.quietEnd, maxListings: cfg.maxListings, maxDigests: cfg.maxDigests, minGapMin: cfg.minGapMin, testAt: null });
const targetView = t => ({ id: t.id, channel: t.channel, label: t.label, createdAt: t.createdAt, lastOkAt: t.lastOkAt, failing: t.failures > 0 });
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Router for /api/alerts/*. The app gate has already refused the public (401) and pending users (403)
 * and checked the Origin of non-GET requests. seg = path segments after /api/alerts.
 */
export async function alertsApi(request, env, method, seg, url, repo, fetchFn, who, deps = {}) {
  const [res, id] = seg; const uid = who.user.id; const now = deps.now ?? Date.now();
  const settings = await repo.getSettings();
  const cfg = alertsConfig(settings);
  const blocked = alertsBlocked(cfg, env, who.role);

  if (res === 'config' && !id && method === 'GET') {
    const [prefs, areas, targets] = await Promise.all([repo.alertPrefs(uid), repo.alertAreas(uid), repo.alertTargets(uid)]);
    return json({
      enabled: !blocked, reason: blocked, message: blocked ? BLOCKED_MSG[blocked] : null,
      vapidPublicKey: blocked ? null : env.VAPID_PUBLIC_KEY,
      prefs: prefs || { ...defaultPrefs(cfg), enabled: false }, areas, targets: targets.map(targetView),
      limits: { maxAreas: MAX_ALERT_AREAS, maxTargets: MAX_TARGETS, maxListings: cfg.maxListings, maxDigests: cfg.maxDigests, bhks: BHK_VALUES },
    });
  }
  // Removing a device always works, even with alerts off (sign-out on a shared device).
  if (res === 'targets' && id && seg.length === 2 && method === 'DELETE') {
    const tid = /^\d{1,12}$/.test(id) ? Number(id) : null; if (tid == null) throw new HttpError(400, 'bad_id');
    return (await repo.deleteAlertTarget(uid, tid)) ? new Response(null, { status: 204 }) : errorJson(404, 'not_found');
  }
  if (blocked) return errorJson(403, 'alerts_off', BLOCKED_MSG[blocked], { reason: blocked });

  if (res === 'prefs' && !id && method === 'PUT') {
    const b = await readJson(request, 4 * KB);
    if (!b || typeof b !== 'object') throw new HttpError(400, 'bad_body');
    const cur = (await repo.alertPrefs(uid)) || defaultPrefs(cfg);
    const next = { ...cur };
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'bad_enabled'); next.enabled = b.enabled; }
    const num = (k, lo, hi, what) => { if (b[k] === undefined) return; if (!intIn(b[k], lo, hi)) throw new HttpError(400, 'bad_' + k, `${what} must be a whole number from ${lo} to ${hi}.`); next[k] = b[k]; };
    num('quietStart', 0, 23, 'Quiet hours start'); num('quietEnd', 0, 23, 'Quiet hours end');
    num('maxListings', 1, 50, 'Listings per day'); num('maxDigests', 1, 12, 'Alerts per day'); num('minGapMin', 30, 720, 'Minutes between alerts');
    return json({ prefs: await repo.putAlertPrefs(uid, next, now) });
  }
  if (res === 'areas' && !id && method === 'PUT') {
    const b = await readJson(request, 4 * KB);
    if (!Array.isArray(b?.areas)) throw new HttpError(400, 'bad_areas', 'Send {areas: [...]}.');
    if (b.areas.length > MAX_ALERT_AREAS) throw new HttpError(400, 'too_many_areas', `Alerts work for at most ${MAX_ALERT_AREAS} areas.`);
    const followed = new Set((await repo.listUserAreas(uid)).map(a => a.id)); const seen = new Set();
    const areas = b.areas.map(a => {
      if (!a || !Number.isInteger(a.areaId)) throw new HttpError(400, 'bad_area');
      if (!followed.has(a.areaId)) throw new HttpError(400, 'not_followed', 'Follow an area before turning on its alerts.');
      if (seen.has(a.areaId)) throw new HttpError(400, 'duplicate_area'); seen.add(a.areaId);
      if (a.maxRent != null && !intIn(a.maxRent, 1000, 1000000)) throw new HttpError(400, 'bad_max_rent', 'Max rent must be from ₹1,000 to ₹10,00,000.');
      const bhks = a.bhks == null ? [] : a.bhks;
      if (!Array.isArray(bhks) || bhks.length > BHK_VALUES.length || !bhks.every(x => BHK_VALUES.includes(x))) throw new HttpError(400, 'bad_bhks');
      return { areaId: a.areaId, maxRent: a.maxRent ?? null, bhks: [...new Set(bhks)] };
    });
    return json({ areas: await repo.replaceAlertAreas(uid, areas, now, defaultPrefs(cfg)) });
  }
  if (res === 'targets' && !id && method === 'POST') {
    const b = await readJson(request, 4 * KB);
    const ch = channels[b?.channel || 'webpush'];
    if (!ch) throw new HttpError(400, 'bad_channel');
    const t = ch.validateTarget(b);
    const tid = await repo.upsertAlertTarget({ userId: uid, channel: ch.name, ...t }, now, MAX_TARGETS);
    return json({ id: tid }, 201);
  }
  return errorJson(404, 'not_found', 'No such API route.');
}

export { HOUR, DAY, IST };
