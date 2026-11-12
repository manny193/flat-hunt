// Place lookup (docs/AI-EXTRACTION.md, "Where is the flat"). Some posts never name an area: they give a
// society name ("Sobha Dream Acres") or only a Google Maps link. For those, and only those, this step finds
// an address and lets the normal area keywords match it:
//   map link -> follow the short link to the full Google Maps URL (place name + coordinates), then, when the
//               place name names none of our areas, reverse-geocode the coordinates;
//   society  -> search OpenStreetMap (Nominatim) inside Bangalore; the result must carry the society's name.
// Free and keyless. Nominatim's usage policy: at most 1 request a second, an identifying User-Agent, results
// cached (table `places`). No phone, author or post text is sent: only the society name or coordinates.
// Queue: loc_queue, filled by the AI enrich pass (src/ai.js), drained here by the cron, a few per tick.
import { normText, matchAreas, listingAreas, retagAreas, makeContext } from './core/logic.js';
import { enqueueStatement, alertsConfig } from './alerts.js';

export const NOMINATIM = 'https://nominatim.openstreetmap.org';
export const CITY = { name: 'Bengaluru', south: 12.70, north: 13.25, west: 77.30, east: 77.90 };
export const LOC_MAX_ATTEMPTS = 4;
export const LOC_QUERIES = 12; // 5 reads (due, listings, areas, places cache, settings) + a save batch of up to 6 statements, +1 spare
const NEGATIVE_TTL = 30 * 864e5; // a society that was not found is asked for again after a month
const SHORT_HOST = /^(?:maps\.app\.goo\.gl|goo\.gl|g\.co)$/i;
const MAP_HOST = /^(?:maps\.app\.goo\.gl|goo\.gl|g\.co|(?:www\.|maps\.)?google\.[a-z.]{2,8})$/i;
const wait = ms => new Promise(r => setTimeout(r, ms));
const userAgent = env => `FlatHunt/1.0 (${env?.PUBLIC_BASE_URL || 'rental listings app'})`;
const inCity = p => p && p.lat >= CITY.south && p.lat <= CITY.north && p.lon >= CITY.west && p.lon <= CITY.east;
const num2 = (a, b) => { const lat = Number(a), lon = Number(b); return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null; };
const COORDS = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/;

/** True when a listing's posts do not place it, but it has something to look up (society or map link). */
export function needsLookup(l, ctx) {
  if (l.isSample || l.place?.text || !((l.mapLinks || []).length || l.society)) return false;
  const pl = l.place || {};
  return !listingAreas({ ...l, place: { area: pl.area, nearby: pl.nearby } }, ctx.areas).length;
}

/** Place name and coordinates written in a full Google Maps URL. Returns {name, lat, lon} (any may be missing) or null. */
export function parseMapUrl(u) {
  let url; try { url = new URL(u); } catch { return null; }
  if (!MAP_HOST.test(url.hostname)) return null;
  const dec = s => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
  let name = null, pos = null;
  const m = url.pathname.match(/\/maps\/(?:place|search|dir\/[^/]*)\/([^/@]+)/);
  if (m) name = dec(m[1]);
  const pin = url.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || url.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (pin) pos = num2(pin[1], pin[2]);
  for (const k of ['q', 'query', 'destination', 'daddr', 'll', 'center']) {
    const v = url.searchParams.get(k); if (!v) continue;
    const c = v.match(COORDS);
    if (c) pos = pos || num2(c[1], c[2]); else if (!name && k !== 'll' && k !== 'center') name = v;
  }
  if (name) { const c = name.match(COORDS); if (c) { pos = pos || num2(c[1], c[2]); name = null; } }
  name = name ? name.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  return name || pos ? { name, lat: pos?.lat ?? null, lon: pos?.lon ?? null } : null;
}

/**
 * Resolve a map link from a post. Short links (maps.app.goo.gl) are followed by hand, at most 4 hops and
 * only across Google hosts. Returns {name, lat, lon} or null; throws on a network error (retried later).
 */
export async function resolveMapLink(link, fetchFn = fetch, env = null) {
  let u = String(link || '');
  for (let hop = 0; hop < 4; hop++) {
    let url; try { url = new URL(u); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname === 'consent.google.com' && url.searchParams.get('continue')) { u = url.searchParams.get('continue'); continue; }
    if (!MAP_HOST.test(url.hostname)) return null;
    const parsed = parseMapUrl(u);
    if (parsed && !SHORT_HOST.test(url.hostname)) return parsed;
    if (!SHORT_HOST.test(url.hostname) && hop > 0) return null;
    const r = await fetchFn(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': userAgent(env) } });
    const next = r.headers?.get?.('location');
    if (r.status >= 500 || r.status === 429) throw new Error('map link HTTP ' + r.status);
    if (!(r.status >= 300 && r.status < 400) || !next) return null;
    u = new URL(next, u).href;
  }
  return null;
}

// Words that do not identify a society ("Apartments", "Residency" ...): the rest must be in the result's name.
const GENERIC = new Set(['apartment', 'apartments', 'residency', 'residences', 'enclave', 'tower', 'towers', 'heights', 'homes', 'nest', 'garden', 'gardens', 'society', 'villa', 'villas', 'phase', 'block', 'the', 'pg', 'for', 'near', 'opp', 'flat', 'flats']);
export const coreTokens = name => normText(name).split(' ').filter(w => w.length >= 3 && !GENERIC.has(w));
/** Address parts area keywords are matched against. No house number, city, state, PIN or country. */
export function addressText(r) {
  const a = r?.address || {};
  const parts = [r?.name, a.amenity, a.building, a.residential, a.road, a.neighbourhood, a.quarter, a.hamlet, a.suburb, a.village, a.town, a.city_district];
  return [...new Set(parts.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))].join(', ').slice(0, 300);
}

async function nominatim(path, params, { fetchFn, env, geo }) {
  if (geo.used > 0) await geo.sleep(1100); // usage policy: at most one request a second
  geo.used++;
  const qs = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'en', ...params });
  const r = await fetchFn(`${NOMINATIM}${path}?${qs}`, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': userAgent(env), accept: 'application/json' } });
  if (r.status === 429 || r.status >= 500) throw new Error('geocoder HTTP ' + r.status);
  if (!r.ok) return null;
  return r.json();
}
/** Find a society in the city. The result must carry every identifying word of the name. {text, lat, lon} or null. */
export async function findSociety(society, opt) {
  const core = coreTokens(society);
  if (!core.length || core.join('').length < 4) return null; // "Sai Nest": too generic to trust a search hit
  const rows = await nominatim('/search', { q: `${society}, ${CITY.name}`, limit: '5', countrycodes: 'in', viewbox: `${CITY.west},${CITY.north},${CITY.east},${CITY.south}`, bounded: '1' }, opt);
  for (const r of Array.isArray(rows) ? rows : []) {
    const pos = num2(r.lat, r.lon); if (!inCity(pos)) continue;
    const label = ' ' + normText(`${r.name || ''} ${String(r.display_name || '').split(',').slice(0, 2).join(' ')}`) + ' ';
    if (!core.every(w => label.includes(' ' + w + ' '))) continue;
    const text = addressText(r); if (text) return { text, ...pos };
  }
  return null;
}
/** Address around a point (street and suburb level). */
export async function addressAt(pos, opt) {
  const r = await nominatim('/reverse', { lat: String(pos.lat), lon: String(pos.lon), zoom: '17' }, opt);
  return r && !r.error ? addressText(r) : '';
}

const backoff = attempts => 30 * 60e3 * Math.pow(2, Math.max(0, attempts - 1));

/**
 * Look up queued listings: at most `max` listings and `maxGeo` geocoder requests per call. Uses up to
 * LOC_QUERIES D1 statements. Listings it cannot reach within maxGeo stay queued. Never throws for network errors.
 */
export async function runLocate(repo, env, { now = Date.now(), fetchFn = fetch, max = 6, maxGeo = 6, sleep = wait } = {}) {
  const due = await repo.locDue(now, max);
  if (!due.length) return { action: 'idle' };
  const [listings, areas, settings] = [await repo.loadListings(due.map(d => d.listing_id)), await repo.listAreas(), await repo.getSettings()];
  const ctx = makeContext(areas, {});
  const keyOf = l => l.society ? normText(l.society).slice(0, 120) : '';
  const cache = await repo.placesGet([...new Set([...listings.values()].map(keyOf).filter(Boolean))]);
  const geo = { used: 0, sleep }; const opt = { fetchFn, env, geo };
  const q = []; const save = []; const newPlaces = []; const placed = [];
  let found = 0, lastError = null;
  for (const d of due) {
    const l = listings.get(d.listing_id);
    if (!l || !needsLookup(l, ctx)) { q.push({ id: d.listing_id, status: 'done', attempts: d.attempts, next_at: now, error: null }); continue; }
    let place = null, deferred = false;
    try {
      for (const link of (l.mapLinks || []).slice(0, 2)) {
        const m = await resolveMapLink(link, fetchFn, env);
        if (!m) continue;
        const pos = num2(m.lat, m.lon); let text = m.name || '';
        if (inCity(pos) && !(text && matchAreas(text, ctx.areas).length)) {
          if (geo.used >= maxGeo) { deferred = true; break; }
          text = [text, await addressAt(pos, opt)].filter(Boolean).join(', ');
        }
        if (text) { place = { text: text.slice(0, 400), src: 'map', ...(pos || {}) }; break; }
      }
      const key = keyOf(l);
      if (!place && !deferred && key) {
        const c = cache.get(key);
        if (c && (c.text || now - c.at < NEGATIVE_TTL)) { if (c.text) place = { text: c.text, src: 'society', lat: c.lat, lon: c.lon }; }
        else if (geo.used >= maxGeo) deferred = true;
        else {
          const r = await findSociety(l.society, opt);
          const row = { key, text: r?.text || '', lat: r?.lat ?? null, lon: r?.lon ?? null, at: now };
          cache.set(key, row); newPlaces.push(row);
          if (r) place = { text: r.text, src: 'society', lat: r.lat, lon: r.lon };
        }
      }
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 200);
      const attempts = d.attempts + 1;
      q.push({ id: l.id, status: attempts >= LOC_MAX_ATTEMPTS ? 'failed' : 'retry', attempts, next_at: now + backoff(attempts), error: lastError });
      continue;
    }
    if (deferred) continue; // stays pending for the next tick
    if (!place) { q.push({ id: l.id, status: 'none', attempts: d.attempts + 1, next_at: now, error: null }); continue; }
    const had = new Set(l.areas || []);
    l.place = { ...(l.place || {}), ...place, at: now };
    retagAreas(l, ctx);
    if (l.areas.some(id => !had.has(id))) placed.push(l.id);
    save.push(l); found++;
    q.push({ id: l.id, status: 'done', attempts: d.attempts + 1, next_at: now, error: null });
  }
  const extra = [];
  if (q.length) extra.push(repo.locUpdateStatement(q, now));
  if (newPlaces.length) extra.push(repo.placesUpsertStatement(newPlaces));
  // A listing gained an area it did not have at ingest, so it could not alert that area's followers then; it can now.
  if (placed.length && alertsConfig(settings).enabled) extra.push(enqueueStatement(placed, now));
  if (save.length || extra.length) await repo.saveIngest({ listings: save, keys: [], run: null, now, extra });
  return { action: 'ran', checked: q.length, found, tagged: save.filter(l => l.areas.length).length, lookups: geo.used, waiting: due.length - q.length, ...(lastError ? { error: lastError } : {}) };
}
