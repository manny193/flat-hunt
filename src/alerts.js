// Area alerts over Web Push (docs/ai/ALERTS-WEBPUSH.md). Payload-less: the push carries nothing; the
// service worker (web/sw.js) fetches the notification text from GET /api/alerts/inbox with the session
// cookie, so listing details never pass through Google, Mozilla or Apple and the role is re-checked at
// display time. This module holds the ingest enqueue statement, the user and admin API, the cron send
// step and the notification text builder.
import { HttpError, json, errorJson, readJson } from './http.js';
import { channels } from './channels/index.js';
import { adminEmails } from './auth.js';

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

// ---------- cron send step ----------
// A dedicated Cron Trigger runs only this step, so it starts with the full 48-query / 50-subrequest budget.
export const ALERT_CRON = '*/10 * * * *';
export const MAX_SENDS = 40;          // pushes per invocation: 1 subrequest each, 10 of 50 kept spare
const SEND_CONCURRENCY = 6;           // Workers allow 6 simultaneous open connections
const DUE_USERS = 60;
export const EXPIRE_MS = 36 * HOUR;   // a night of quiet hours plus a day of failures
export const istHourOf = t => Math.floor((((t + IST) % DAY) + DAY) % DAY / HOUR);
export const istDayStart = t => Math.floor((t + IST) / DAY) * DAY - IST;
/** Quiet window in IST hours; it may wrap midnight (22 → 8). start == end means no quiet hours. */
export function inQuiet(hour, start, end) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
/** Wrap fetch so every call counts as a subrequest (like budgeted() for D1 queries). */
export function countedFetch(fetchFn, cap = 50) {
  let n = 0;
  const f = (...a) => { n++; return fetchFn(...a); };
  f.used = () => n; f.left = () => cap - n;
  return f;
}
const isAdminRow = (u, env) => u.role === 'admin' || adminEmails(env).includes(String(u.email || '').toLowerCase());

/**
 * One alert run. repo should be budgeted() (has left()). Constant D1 cost: settings + due users +
 * targets + one write-back batch (<= 6) + one settings write = at most 10; an idle run is 2.
 * Users who cannot be sent this run (quiet hours, min gap, digest cap, send budget) keep their rows
 * pending for the next run, oldest first. Returns a small status object (no personal data).
 */
export async function alertStep(repo, env, { fetchFn = fetch, now = Date.now(), maxSends = MAX_SENDS } = {}) {
  if (!vapidConfigured(env)) return { action: 'off', reason: 'not_configured' };
  if (repo.left && repo.left() < 10) return { action: 'skipped', reason: 'budget' };
  const settings = await repo.getSettings();
  const cfg = alertsConfig(settings);
  if (!cfg.enabled) return { action: 'off', reason: 'off' };
  const dayStart = istDayStart(now);
  const prev = settings.alertsRun && typeof settings.alertsRun === 'object' ? settings.alertsRun : {};
  const pushedToday = prev.day === dayStart ? prev.pushesToday || 0 : 0;
  const due = await repo.alertDueUsers(dayStart, DUE_USERS);
  if (!due.length) return { action: 'idle' };

  const hour = istHourOf(now);
  const capped = [], eligible = [];
  for (const u of due) {
    if (cfg.adminOnly && !isAdminRow(u, env)) continue; // soft launch: rows wait (and expire) until opened up
    if (inQuiet(hour, u.quiet_start, u.quiet_end)) continue;
    if (u.sent_today >= Math.min(u.max_listings, cfg.maxListings)) { capped.push(u.user_id); continue; }
    if (u.digests_today >= Math.min(u.max_digests, cfg.maxDigests)) continue;
    if (u.last_sent && now - u.last_sent < u.min_gap_min * 60e3) continue;
    eligible.push(u.user_id);
  }
  const cf = countedFetch(fetchFn);
  let budget = Math.max(0, Math.min(maxSends, cf.left() - 10, cfg.maxPushesPerDay - pushedToday));
  const targets = eligible.length && budget ? await repo.alertTargetsForSend(eligible) : [];
  const byUser = new Map(eligible.map(id => [id, []]));
  for (const t of targets) byUser.get(t.user_id)?.push(t);
  const chosen = [], chosenUsers = [];
  for (const [uid, list] of byUser) {
    if (!budget) break;
    if (!list.length) { capped.push(uid); continue; } // no working device: shown on #alerts, not pushed
    if (list.length > budget) break;                   // keep users whole; the rest go next run, in order
    chosen.push(...list); chosenUsers.push(uid); budget -= list.length;
  }

  const results = [];
  let lastError = null;
  if (chosen.length) {
    let vapid;
    try { const { importVapid } = channels.webpush; vapid = await importVapid(env); } catch { lastError = 'vapid_invalid'; }
    if (vapid) {
      const ctx = { fetchFn: cf, vapid, now, skipOrigins: new Set() };
      for (let i = 0; i < chosen.length; i += SEND_CONCURRENCY) {
        const part = chosen.slice(i, i + SEND_CONCURRENCY);
        results.push(...await Promise.all(part.map(async t => ({ t, r: channels[t.channel] ? await channels[t.channel].send(t, null, ctx) : { ok: false, error: 'no_channel' } }))));
      }
    }
  }
  const okIds = [], goneIds = [], failed = [], sentUsers = new Set();
  for (const { t, r } of results) {
    if (r.ok) { okIds.push(t.id); sentUsers.add(t.user_id); continue; }
    lastError = r.error || 'error';
    if (r.gone) goneIds.push(t.id);
    else if (r.error !== 'http_429') failed.push({ id: t.id, error: r.error || 'error' }); // 429: not the device's fault
  }
  await repo.alertWriteBack({ now, sentUsers: [...sentUsers], cappedUsers: capped, expireBefore: now - EXPIRE_MS, goneIds, failed, okIds });
  const status = { action: 'sent', due: due.length, users: sentUsers.size, pushes: okIds.length, failed: failed.length, gone: goneIds.length, capped: capped.length, waiting: due.length - sentUsers.size - capped.length };
  await repo.putSettings({ alertsRun: { day: dayStart, pushesToday: pushedToday + cf.used(), lastRunAt: now, lastError, last: status } });
  return status;
}

export { HOUR, DAY, IST };
