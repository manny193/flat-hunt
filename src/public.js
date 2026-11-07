// Public (no login) read-only API: browse listings in any area with filters. Responses go through the
// public serializer (src/serialize.js), and every request counts against a per-IP limit in D1.
//   GET /api/public/areas
//   GET /api/public/listings?area=&bhk=&minRent=&maxRent=&type=&kind=&before=&limit=
//   GET /api/public/listings/<id>

import { json, errorJson, clientIp, HttpError } from './http.js';
import { publicListing } from './serialize.js';

export const PUBLIC_WINDOW_MS = 60e3;
export const publicLimit = env => Math.max(5, parseInt(env.PUBLIC_RATE_LIMIT, 10) || 60);
const int = v => (v != null && /^\d{1,15}$/.test(String(v)) ? Number(v) : null);
const TYPES = ['flat', 'flatmate', 'pg'];

/** Count this request for the caller's IP. Returns a 429 Response when over the limit, else null. */
export async function rateLimit(request, env, repo, now = Date.now()) {
  const n = await repo.hitRate('pub:' + clientIp(request), now, PUBLIC_WINDOW_MS);
  if (n > publicLimit(env)) return json({ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' }, 429, { 'retry-after': '60' });
  return null;
}

export async function publicApi(request, env, repo, path, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return errorJson(405, 'method_not_allowed');
  const limited = await rateLimit(request, env, repo);
  if (limited) return limited;
  const seg = path.split('/').slice(3); // after /api/public
  const q = url.searchParams;

  if (seg[0] === 'areas' && seg.length === 1) {
    const areas = (await repo.areaStats(Date.now())).filter(a => a.active).map(a => ({ id: a.id, name: a.name, listings: a.listings, listings7d: a.listings7d }));
    return json({ areas });
  }
  if (seg[0] === 'listings' && seg.length === 1) {
    const opt = (name, ok) => { const v = q.get(name); if (v == null || v === '') return null; if (!ok(v)) throw new HttpError(400, 'bad_' + name); return v; };
    const area = opt('area', v => int(v) != null);
    const bhk = opt('bhk', v => /^(\d(\.5)?|1RK)$/i.test(v));
    const minRent = opt('minRent', v => int(v) != null), maxRent = opt('maxRent', v => int(v) != null);
    const type = opt('type', v => TYPES.includes(v));
    const kind = opt('kind', v => v === 'offer' || v === 'seeking') || 'offer';
    const before = opt('before', v => int(v) != null);
    const limit = Math.min(60, Math.max(1, int(q.get('limit')) || 30));
    const rows = await repo.publicListings({ area: area != null ? int(area) : null, bhk: bhk ? (bhk.toUpperCase() === '1RK' ? '1RK' : bhk) : null, minRent: int(minRent), maxRent: int(maxRent), type, kind, before: int(before), limit });
    return json({ listings: rows.map(l => publicListing(l)), next: rows.length === limit ? rows[rows.length - 1].lastPostedAt : null });
  }
  if (seg[0] === 'listings' && seg.length === 2) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(seg[1])) throw new HttpError(400, 'bad_id');
    const l = await repo.getListing(seg[1]);
    if (!l || l.isSample || !(l.areas || []).length) return errorJson(404, 'not_found');
    return json(publicListing(l, { maxPosts: 15 }));
  }
  return errorJson(404, 'not_found', 'No such API route.');
}
