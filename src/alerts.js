// Area alerts over Web Push (docs/ai/ALERTS-WEBPUSH.md). Payload-less: the push carries nothing; the
// service worker (web/sw.js) fetches the notification text from GET /api/alerts/inbox with the session
// cookie, so listing details never pass through Google, Mozilla or Apple and the role is re-checked at
// display time. This module holds the ingest enqueue statement, the user and admin API, the cron send
// step and the notification text builder.

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

export { HOUR, DAY, IST };
