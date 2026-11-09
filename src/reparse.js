// Re-check stored listings with the current extraction rules (type, kind, room bathroom, rent split, areas).
// Used by the admin "Re-check all listings" button and, after a rule change (RULES_VERSION in core/logic.js),
// by the 10-minute cron: one small page per tick, resumable by rowid, so it fits the Workers Free CPU and
// D1 query limits. State: settings.reparse = { version, next, checked, changed, startedAt, doneAt }.
import { reparseListing, makeContext, RULES_VERSION } from './core/logic.js';

export const REPARSE_PAGE = 20;
export const REPARSE_TEXT_BYTES = 60000;
// The cron shares its invocation with the alert step, so its page is half the admin one.
export const CRON_PAGE = 10, CRON_TEXT_BYTES = 30000;
export const CRON_QUERIES = 6; // settings + areas + page + save batch + settings write (+1 spare)

/** One page after rowid `after`. Returns {checked, changed, next, done}. 2 queries (+1 when something changed). */
export async function reparsePage(repo, { after = 0, page = REPARSE_PAGE, textBytes = REPARSE_TEXT_BYTES, areas = null, now = Date.now() } = {}) {
  const ctx = makeContext(areas ?? await repo.listAreas(), {});
  const rows = await repo.listingsAfterRowid(after, page);
  const take = []; let bytes = 0;
  for (const r of rows) { take.push(r); bytes += (r.listing.posts || []).reduce((n, p) => n + (p.text || '').length, 0); if (bytes >= textBytes) break; }
  const changed = take.map(r => r.listing).filter(l => reparseListing(l, ctx));
  if (changed.length) await repo.saveIngest({ listings: changed, keys: [], run: null, now });
  return { checked: take.length, changed: changed.length, next: take.at(-1)?.rid ?? after, done: take.length === rows.length && rows.length < page };
}

/** Cron step: continue (or start, after a rule change) the automatic re-check. Returns null when nothing to do. */
export async function reparseStep(repo, { now = Date.now(), settings = null } = {}) {
  const s = settings ?? await repo.getSettings();
  let st = s.reparse || {};
  if (st.version === RULES_VERSION && st.doneAt) return null;
  if (st.version !== RULES_VERSION) st = { version: RULES_VERSION, next: 0, checked: 0, changed: 0, startedAt: now };
  const r = await reparsePage(repo, { after: st.next || 0, page: CRON_PAGE, textBytes: CRON_TEXT_BYTES, now });
  st = { ...st, next: r.next, checked: st.checked + r.checked, changed: st.changed + r.changed, ...(r.done ? { doneAt: now } : {}) };
  await repo.putSettings({ reparse: st });
  return st;
}
