// Pure listing logic ported from the approved prototype (docs/prototype-index.html, LOGIC block).
// No platform APIs here: runs in Workers, Node and tests alike.
// Changes vs prototype: multi-area keyword matching, structured watched groups, Apify row shapes,
// a stricter same-phone rule (see scoreCandidate) and injectable ids.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
export const normText = t => String(t || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
export const textHash = t => fnv(normText(t).replace(/\s/g, '').slice(0, 700));
const tokCache = new Map();
export function tokens(t) { const k = String(t || ''); let s = tokCache.get(k); if (!s) { s = new Set(normText(k).split(' ').filter(w => w.length >= 3)); if (tokCache.size > 5000) tokCache.clear(); tokCache.set(k, s); } return s; }
export function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); }
export function normUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u); x.hash = '';
    const keep = ['story_fbid', 'id', 'fbid', 'multi_permalinks']; const q = new URLSearchParams();
    keep.forEach(k => { if (x.searchParams.get(k)) q.set(k, x.searchParams.get(k)); });
    return (x.hostname.replace(/^(www|m|web|mbasic)\./, '') + x.pathname.replace(/\/+$/, '') + (q.toString() ? '?' + q : '')).toLowerCase();
  } catch { return String(u).toLowerCase(); }
}

/** Keywords from a newline/comma string or an array; normalised like post text. */
export function keywordList(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[,\n]/);
  return arr.map(s => normText(s)).filter(Boolean);
}
export function matchesKeywords(text, kws) { if (!kws.length) return true; const n = normText(text), c = n.replace(/\s/g, ''); return kws.some(k => n.includes(k) || c.includes(k.replace(/\s/g, ''))); }

/**
 * Which areas a post mentions. areas: [{id, kws:[normalised keywords]}] (active areas only).
 * Normalises the text once, then does plain substring checks: cheap enough for the ingest hot path.
 */
export function matchAreas(text, areas) {
  if (!areas.length) return [];
  const n = normText(text), c = n.replace(/\s/g, '');
  const out = [];
  for (const a of areas) if (a.kws.some(k => n.includes(k) || c.includes(k.replace(/\s/g, '')))) out.push(a.id);
  return out;
}

export function moneyMentions(text) {
  const out = []; const re = /(₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(k\b|thousand|lakhs?\b|lacs?\b|l\b)?/gi; let m;
  while ((m = re.exec(text))) {
    const [all, cur, num, unit] = m; const digits = num.replace(/[,.]/g, '');
    if (digits.length >= 9) continue;
    let n = parseFloat(num.replace(/,/g, '')); const u = (unit || '').toLowerCase();
    if (u.startsWith('k') || u === 'thousand') n *= 1000; else if (u) n *= 100000;
    if (!(cur || unit || /,/.test(num) || digits.length >= 4)) continue;
    if (!cur && !unit && /^5[67]\d{4}$/.test(digits)) continue; // Bangalore PIN codes
    if (n < 1000 || n > 10000000) continue;
    const after = text.slice(m.index + all.length, m.index + all.length + 24).toLowerCase();
    if (/^\s*(sq|sqft|sft|square|ft\b)/.test(after)) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase().split(/[.;\n|!?]|,(?!\d)/).pop();
    let label = null, best = -1;
    for (const [name, r] of [['deposit', /deposit|advance|security/g], ['maintenance', /maint\w*/g], ['brokerage', /brokerage|broker|commission/g], ['rent', /rent|rental|price|cost|budget/g]]) { let mm, last = -1; r.lastIndex = 0; while ((mm = r.exec(before))) last = mm.index; if (last > best) { best = last; label = name; } }
    if (/^\s*(\/-)?\s*(rs\.?|inr)?\s*(as\s+)?(deposit|advance|security)/.test(after)) label = 'deposit';
    else if (/^\s*(\/-)?\s*(rs\.?|inr)?\s*(as\s+)?maint/.test(after)) label = 'maintenance';
    else if (!label && /^\s*(\/-)?\s*(rs\.?|inr)?\s*(rent|per month|\/month|pm\b|p\.m|monthly)/.test(after)) label = 'rent';
    if (!cur && !unit && !label && n >= 2020 && n <= 2035 && !/,/.test(num)) continue; // years
    out.push({ n: Math.round(n), label, idx: m.index });
  }
  return out;
}

export function extract(text) {
  const t = String(text || ''); const lo = t.toLowerCase(); const ex = {};
  const money = moneyMentions(t);
  const rent = money.find(x => x.label === 'rent' && x.n >= 2000 && x.n <= 400000) || money.find(x => !x.label && x.n >= 3000 && x.n <= 400000);
  ex.rent = rent ? rent.n : null;
  const dep = money.find(x => x.label === 'deposit'); ex.deposit = dep ? dep.n : null;
  const mt = money.find(x => x.label === 'maintenance' && x.n < 30000); ex.maintenance = mt ? mt.n : null;
  const br = money.find(x => x.label === 'brokerage'); ex.brokerageAmount = br ? br.n : null;
  const dm = lo.match(/(\d{1,2})\s*(?:months?|mnths?)'?\s*(?:of\s*)?(?:rent\s*)?(?:as\s*)?(?:deposit|advance|security)/) || lo.match(/(?:deposit|advance|security)[^\d\n]{0,14}(\d{1,2})\s*(?:months?|mnths?)/);
  ex.depositMonths = dm ? +dm[1] : null;
  const b = lo.match(/\b(\d(?:\.5)?)\s*-?\s*b\s?h\s?k\b/) || lo.match(/\b(\d)\s*bed\s*rooms?\b/);
  ex.bhk = b ? +b[1] : (/\b1\s*rk\b/.test(lo) ? '1RK' : null);
  const mateRe = /flat\s*-?\s*mates?|room\s*-?\s*mates?|sharing|replacement|single occupancy|private room|room available|room for rent|\bbed\b(?! ?room)/;
  if (/\bpg\b|paying guest|co-?living/.test(lo)) ex.type = 'pg';
  else if (mateRe.test(lo)) ex.type = 'flatmate';
  else if (ex.bhk != null) ex.type = 'flat';
  else ex.type = null;
  const seeking = /\b(looking|searching|need|needed|require|required|want|wanted|in search)\b(\s+for)?(\s+an?)?(\s+\d\s*bhk)?(\s+(fully|semi)[\s-]*furnished)?\s+(flat|room|accommodation|pg|place|house|apartment|1\s*rk|\d\s*bhk|home)\b/.test(lo);
  const offering = /available|vacant|vacating|for rent|to[\s-]let|rent is|rent:|move[\s-]?in|flat\s*-?\s*mates?\b|room\s*-?\s*mates?\b|replacement/.test(lo);
  ex.kind = (seeking && !offering) ? 'seeking' : 'offer';
  if (/fully[\s-]*furnished/.test(lo)) ex.furnishing = 'fully'; else if (/semi[\s-]*furnished/.test(lo)) ex.furnishing = 'semi'; else if (/un[\s-]?furnished|bare\s*shell/.test(lo)) ex.furnishing = 'unfurnished'; else ex.furnishing = null;
  if (/\b(no|zero|0|nil|without)\s*(brokerage|broker)|brokerage\s*(free|nil|none|[:-]?\s*no\b|[:-]?\s*0\b)|no\s*brokers?\b|direct(ly)?\s*(from\s*)?(the\s*)?owner|owner\s*(post|directly|here)|not\s*a\s*broker/.test(lo)) ex.brokerage = 'no';
  else if (/brokerage|\bbroker\b|commission|\bagent\b/.test(lo)) ex.brokerage = 'yes'; else ex.brokerage = null;
  const fem = /\b(female|girls?|ladies|women|woman)\b/.test(lo), male = /\b(male|boys?|gents|men)\b/.test(lo.replace(/female/g, ''));
  ex.gender = fem && male ? 'any' : fem ? 'female' : male ? 'male' : null;
  const av = t.match(/\b(?:available|vacant|move[\s-]?in)\s*(?:from|by|on|date)?\s*[:-]?\s*((?:immediate(?:ly)?|\d{1,2}(?:st|nd|rd|th)?\s*(?:of\s*)?[A-Za-z]{3,9}|[A-Za-z]{3,9}\s*\d{1,2}(?:st|nd|rd|th)?|[A-Za-z]{3,9}\s*(?:1st|first)\s*week|next\s*month|this\s*month))/i);
  ex.availableFrom = av ? av[1].trim() : (/\bimmediate(ly)?\b/i.test(t) ? 'Immediate' : null);
  ex.phones = [...new Set([...t.matchAll(/(?:\+?91[\s-]*)?\b([6-9](?:[\s-]?\d){9})\b/g)].map(x => x[1].replace(/\D/g, '')))];
  ex.mapLinks = [...new Set([...t.matchAll(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)[^\s)\]]*/gi)].map(x => x[0]))];
  const soc = t.match(/\b([A-Z][A-Za-z0-9&']+(?:\s+[A-Z][A-Za-z0-9&']+){0,3})\s+(Apartments?|Residency|Enclave|Towers?|Heights|Homes|Nest|Gardens?|Meadows|Elite|Palms|Society)\b/);
  ex.society = soc ? soc[0] : null;
  return ex;
}

export function pick(o, keys) { for (const k of keys) { const v = k.split('.').reduce((a, p) => a == null ? a : a[p], o); if (v != null && v !== '') return v; } return null; }
export function asName(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v.name || v.title || v.text || ''; return String(v); }
export function collectImages(o, out = new Set(), depth = 0) {
  if (depth > 6 || o == null) return out;
  if (typeof o === 'string') { if (/^https?:\/\//.test(o) && /(fbcdn|scontent|\.jpe?g|\.png|\.webp)/i.test(o) && !/profile|emoji|rsrc|static\.xx/i.test(o)) out.add(o); return out; }
  if (Array.isArray(o)) { o.forEach(x => collectImages(x, out, depth + 1)); return out; }
  if (typeof o === 'object') { for (const [k, v] of Object.entries(o)) { if (/profile|avatar|author|user|icon|owner|group|logo|comments?/i.test(k)) continue; collectImages(v, out, depth + 1); } }
  return out;
}
export function toTime(v) { if (v == null || v === '') return null; if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; if (/^\d+$/.test(String(v))) { const n = +v; return n < 1e12 ? n * 1000 : n; } const t = Date.parse(v); return isNaN(t) ? null : t; }
export function relTime(txt, base) {
  if (!txt) return null; const s = String(txt).toLowerCase().trim(); const now = base || Date.now();
  if (/just now|now/.test(s)) return now;
  const m = s.match(/(\d+)\s*(s|sec|secs|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)\b/);
  if (m) { const n = +m[1], u = m[2][0]; const mult = u === 's' ? 1e3 : u === 'm' ? 6e4 : u === 'h' ? 36e5 : u === 'd' ? 864e5 : 6048e5; return now - n * mult; }
  if (/yesterday/.test(s)) return now - 864e5;
  return null;
}
const isUrl = v => typeof v === 'string' && /^https?:\/\//i.test(v);
export function normalizeRaw(raw, source, now = Date.now()) {
  if (typeof raw === 'string') raw = { text: raw };
  if (!raw || typeof raw !== 'object') raw = {};
  const text = String(pick(raw, ['text', 'postText', 'post_text', 'message', 'content', 'body', 'caption', 'description']) || '').trim();
  const url = String(pick(raw, ['url', 'postUrl', 'post_url', 'permalink', 'link', 'topLevelUrl']) || '');
  const author = asName(pick(raw, ['user', 'author', 'authorName', 'userName', 'ownerName', 'profileName', 'name']));
  const group = asName(pick(raw, ['groupTitle', 'groupName', 'group_name', 'group', 'pageName', 'groupTitleText']));
  // automly's actor puts the group URL in `source`; only trust it when it is a URL.
  const groupUrl = String(pick(raw, ['groupUrl', 'group.url', 'inputUrl', 'facebookUrl']) || (isUrl(raw.source) ? raw.source : '') || '');
  const timeText = String(pick(raw, ['timeText', 'time_text']) || '');
  let postedAt = toTime(pick(raw, ['time', 'timestamp', 'date', 'createdAt', 'created_time', 'publishedAt', 'postedAt', 'creation_time', 'postedAtEstimate']));
  if (!postedAt && timeText) postedAt = relTime(timeText, toTime(raw.capturedAt) || now);
  if (postedAt && postedAt > now + 864e5) postedAt = null; // clock garbage
  const images = [...collectImages(raw)].slice(0, 12);
  return { text, url, urlKey: normUrl(url), author, group, groupUrl, timeText, postedAt, images, source, th: textHash(text), groupKnownHint: raw.groupKnown };
}

/**
 * Apify datasets from the primary actor mix row types: "group" rows (id, name, url, privacy),
 * "post" rows (groupId refers to a group row) and "report" rows. Resolve group names onto posts,
 * drop non-post rows and collect groups that could not be scraped. Rows without `type`
 * (official actor, phone scan, manual) pass through untouched.
 */
export function prepareItems(rows) {
  if (!Array.isArray(rows)) return { items: [], groups: [], unscrapable: [] };
  const groups = new Map(); const unscrapable = []; const items = [];
  const typeOf = r => (r && typeof r === 'object' && typeof r.type === 'string') ? r.type.toLowerCase() : '';
  for (const r of rows) {
    if (typeOf(r) !== 'group') continue;
    const g = { id: String(r.id ?? r.groupId ?? ''), name: asName(r.name ?? r.title), url: String(r.url || r.groupUrl || ''), privacy: String(r.privacy || '').toLowerCase() };
    if (g.id) groups.set(g.id, g);
    if (g.privacy && g.privacy !== 'public' && g.privacy !== 'open') unscrapable.push({ name: g.name, url: g.url, reason: g.privacy });
  }
  for (const r of rows) {
    const t = typeOf(r);
    if (t === 'group') continue;
    if (t === 'report' || t === 'summary' || t === 'error') { unscrapable.push(...reportFailures(r)); continue; }
    if (t && t !== 'post') continue;
    if (r && typeof r === 'object' && r.groupId != null && !r.groupTitle && !r.groupName) {
      const g = groups.get(String(r.groupId));
      if (g) { items.push({ ...r, groupName: g.name, groupUrl: r.groupUrl || g.url || (isUrl(r.source) ? r.source : '') }); continue; }
    }
    items.push(r);
  }
  const seen = new Set();
  return { items, groups: [...groups.values()], unscrapable: unscrapable.filter(u => { const k = u.url || u.name; if (!k || seen.has(k)) return false; seen.add(k); return true; }) };
}
// The report row layout is not documented; accept the obvious shapes.
function reportFailures(r) {
  const out = [];
  const lists = ['failedGroups', 'privateGroups', 'skippedGroups', 'unscrapableGroups', 'inaccessibleGroups', 'errors', 'failed'];
  for (const k of lists) {
    const v = r[k]; if (!Array.isArray(v)) continue;
    for (const x of v) {
      if (typeof x === 'string') out.push({ name: '', url: isUrl(x) ? x : '', reason: k.replace(/Groups$/, '') , ...(isUrl(x) ? {} : { name: x }) });
      else if (x && typeof x === 'object') out.push({ name: asName(x.name ?? x.title ?? x.group), url: String(x.url || x.groupUrl || x.inputUrl || ''), reason: String(x.reason || x.error || x.message || k.replace(/Groups$/, '')).slice(0, 120) });
    }
  }
  return out.filter(x => x.url || x.name);
}

export function itemsFromJson(data) {
  if (Array.isArray(data)) return { items: data, source: 'scraper' };
  if (data && Array.isArray(data.posts)) return { items: data.posts, source: data.source === 'phone-scan' ? 'phone' : (data.source || 'scraper'), meta: data };
  if (data && Array.isArray(data.items)) return { items: data.items, source: 'scraper' };
  if (data && typeof data === 'object') return { items: [data], source: 'scraper' };
  return { items: [], source: 'scraper' };
}
export function parseJsonText(txt) {
  txt = String(txt || '').trim(); if (!txt) return null;
  try { return JSON.parse(txt); } catch { /* try JSON lines */ }
  const arr = [];
  for (const l of txt.split(/\n/).map(l => l.trim()).filter(Boolean)) { try { arr.push(JSON.parse(l)); } catch { return null; } }
  return arr;
}
export function groupKey(s) { return normText(s).replace(/\b(the|and|of|in|group|official)\b/g, '').replace(/\s+/g, ' ').trim(); }
/** Watched groups from the structured setting [{name,url,active}] or the prototype's "name | url" lines. */
export function watchedGroups(raw) {
  const list = Array.isArray(raw)
    ? raw.filter(g => g && g.active !== false).map(g => ({ name: String(g.name || '').trim(), url: String(g.url || '').trim() }))
    : String(raw || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, url] = l.split('|').map(s => (s || '').trim()); return { name, url }; });
  return list.filter(g => g.name || g.url).map(({ name, url }) => ({ name, key: groupKey(name), urlKey: normUrl(url || (/^https?:/.test(name) ? name : '')) }));
}
export function isKnownGroup(group, groupUrl, watched) {
  if (!watched.length) return null;
  const u = normUrl(groupUrl); const g = groupKey(group);
  return watched.some(w => (u && w.urlKey && (u.startsWith(w.urlKey) || w.urlKey.startsWith(u))) || (g && w.key && (g === w.key || (g.length > 6 && w.key.length > 6 && (g.includes(w.key) || w.key.includes(g))))));
}

export const bhkOk = (a, b) => a == null || b == null || String(a) === String(b);
export const rentOk = (a, b) => !a || !b || Math.abs(a - b) / Math.max(a, b) <= 0.12;
export const RENT_WINDOW = 0.12;
export const MATCH_THRESHOLD = 0.6;

/** Token strings of a listing's latest posts, used for fuzzy matching (stored as listings.fp). */
export function fingerprint(l) { return (l.posts || []).slice(0, 5).map(q => [...tokens(q.text)].slice(0, 160).join(' ')); }

/**
 * Score how likely post (p, ex) is a repost of candidate c = {kind,bhk,rent,phones,fp}.
 * Caller has already checked kind/BHK/rent compatibility.
 * Same phone counts as a match only when BHK and rent are both stated AND the rent is (nearly) equal
 * or the texts overlap somewhat: brokers post many different flats with one number.
 */
export function scoreCandidate(tok, ex, c) {
  let score = 0, best = 0;
  for (const s of c.fp || []) {
    const t = tokens(s); const lo = Math.min(t.size, tok.size), hi = Math.max(t.size, tok.size);
    if (!hi || lo / hi < 0.3) continue; // jaccard can't reach 0.3: skip the set walk
    best = Math.max(best, jaccard(tok, t));
  }
  score = best;
  if (ex.phones.length && (c.phones || []).some(x => ex.phones.includes(x)) && c.bhk != null && ex.bhk != null && c.rent && ex.rent) {
    const nearSameRent = Math.abs(c.rent - ex.rent) / Math.max(c.rent, ex.rent) <= 0.02;
    if (nearSameRent || best >= 0.3) score = Math.max(score, 0.9);
  }
  return score;
}
export const compatible = (c, ex) => (c.kind || 'offer') === ex.kind && bhkOk(c.bhk, ex.bhk) && rentOk(c.rent, ex.rent);

/** Reference (in-memory) matcher, same rules as the SQL-backed ingest. */
export function findMatch(p, ex, work) {
  const tok = tokens(p.text); let best = null, bestScore = 0, sameText = null;
  for (const l of work.values()) for (const q of l.posts || []) {
    if (p.urlKey && q.urlKey === p.urlKey) return { listing: l, exact: true };
    if (q.th === p.th) { if (!p.urlKey && !q.urlKey && q.group === (p.group || '')) return { listing: l, exact: true }; sameText = sameText || l; }
  }
  if (sameText) return { listing: sameText, exact: false, score: 1 };
  for (const l of work.values()) {
    if (!compatible(l, ex)) continue;
    if (p.areas && l.areas && !sameAreas(p.areas, l.areas)) continue;
    const score = scoreCandidate(tok, ex, { ...l, fp: fingerprint(l) });
    if (score > bestScore) { bestScore = score; best = l; }
  }
  return best && bestScore >= MATCH_THRESHOLD ? { listing: best, exact: false, score: bestScore } : null;
}
export function sameAreas(a, b) { const A = a.length ? a : [0], B = b.length ? b : [0]; return A.some(x => B.includes(x)); }

export const FIELDS = ['bhk', 'type', 'deposit', 'depositMonths', 'maintenance', 'brokerage', 'brokerageAmount', 'furnishing', 'gender', 'availableFrom', 'society', 'kind'];
export function applyPost(l, p, ex, now) {
  const post = { id: fnv((p.urlKey || '') + '|' + p.th), url: p.url || '', urlKey: p.urlKey || '', th: p.th, group: p.group || '', groupKnown: p.groupKnown, author: p.author || '', text: p.text.slice(0, 3000), postedAt: p.postedAt || null, timeText: p.timeText || '', source: p.source, importedAt: now, images: (p.images || []).slice(0, 10) };
  const when = post.postedAt || now; const newer = !l.lastPostedAt || when >= l.lastPostedAt;
  l.posts = [post, ...(l.posts || [])].sort((a, b) => (b.postedAt || b.importedAt) - (a.postedAt || a.importedAt)).slice(0, 15);
  l.seenCount = (l.seenCount || 0) + 1;
  for (const k of FIELDS) { if (ex[k] != null && ex[k] !== '' && (l[k] == null || l[k] === '' || (newer && k !== 'kind'))) l[k] = ex[k]; }
  if (ex.rent) { if (!l.rent) l.rent = ex.rent; else if (newer && l.rent !== ex.rent) { l.rentHistory = [...(l.rentHistory || []), { rent: l.rent, at: now }].slice(-10); l.rent = ex.rent; } }
  l.phones = [...new Set([...(l.phones || []), ...ex.phones])].slice(0, 6);
  l.mapLinks = [...new Set([...(l.mapLinks || []), ...ex.mapLinks])].slice(0, 6);
  l.groups = [...new Set([...(l.groups || []), post.group].filter(Boolean))];
  l.areas = [...new Set([...(l.areas || []), ...(p.areas || [])])];
  l.lastPostedAt = Math.max(l.lastPostedAt || 0, when); l.firstPostedAt = Math.min(l.firstPostedAt || when, when);
  const flagged = l.posts.filter(q => q.groupKnown === false).length; l.outsideWatched = flagged > 0 && l.posts.every(q => q.groupKnown !== true);
  l.updatedAt = now; if (l.status === 'approved') l.hasUpdate = true;
  return l;
}
export const newId = () => 'l_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
export function newListing(p, ex, now, id = newId()) { return applyPost({ id, status: 'new', stage: '', createdAt: now, posts: [], groups: [], phones: [], mapLinks: [], rentHistory: [], areas: [], notes: '', kind: ex.kind }, p, ex, now); }

export function emptyReport(source, now, total) {
  return { at: now, source, total, noText: 0, offTopic: 0, seeking: 0, dupes: 0, newListings: 0, merged: 0, known: 0, outside: 0, outsideGroups: {}, knownGroups: {}, byArea: {}, unscrapable: [] };
}
/** Normalise, area-filter and classify one raw item. Returns null (and counts it) when skipped. */
export function screenItem(raw, source, ctx, report, now) {
  const p = normalizeRaw(raw, source, now);
  if (!p.text || p.text.length < 15) { report.noText++; return null; }
  p.areas = matchAreas(p.text + ' ' + p.group, ctx.areas);
  if (ctx.keywordFilter !== false && ctx.areas.length && !p.areas.length) { report.offTopic++; return null; }
  let known = isKnownGroup(p.group, p.groupUrl, ctx.watched); if (known == null && typeof p.groupKnownHint === 'boolean') known = p.groupKnownHint;
  p.groupKnown = known;
  const g = p.group || 'Group not detected';
  if (known === false) { report.outside++; report.outsideGroups[g] = (report.outsideGroups[g] || 0) + 1; } else if (known === true) { report.known++; report.knownGroups[g] = (report.knownGroups[g] || 0) + 1; }
  for (const id of p.areas) { const name = ctx.areaNames.get(id) || String(id); report.byArea[name] = (report.byArea[name] || 0) + 1; }
  const ex = extract(p.text); if (ex.kind === 'seeking') report.seeking++;
  return { p, ex };
}
/** ctx from DB rows: areas [{id,name,keywords,active}], settings {groups, keywordFilter}. */
export function makeContext(areas, settings) {
  const active = (areas || []).filter(a => a.active !== false && a.active !== 0);
  return {
    areas: active.map(a => ({ id: a.id, kws: keywordList(a.keywords) })).filter(a => a.kws.length),
    areaNames: new Map((areas || []).map(a => [a.id, a.name])),
    watched: watchedGroups(settings?.groups),
    keywordFilter: settings?.keywordFilter,
  };
}

/**
 * Reference pipeline kept from the prototype: pure, whole tracker in memory.
 * Production ingest (src/ingest.js) applies the same rules against SQL.
 */
export function processItems(rawItems, source, listings, ctx, now = Date.now()) {
  const prepared = prepareItems(rawItems);
  const report = emptyReport(source, now, prepared.items.length); report.unscrapable = prepared.unscrapable;
  const work = new Map(listings.map(l => [l.id, structuredClone(l)])); const changed = new Set();
  for (const raw of prepared.items) {
    const s = screenItem(raw, source, ctx, report, now); if (!s) continue;
    const { p, ex } = s;
    const m = findMatch(p, ex, work);
    if (m && m.exact) { report.dupes++; continue; }
    if (m) { applyPost(m.listing, p, ex, now); changed.add(m.listing.id); report.merged++; }
    else { const l = newListing(p, ex, now); work.set(l.id, l); changed.add(l.id); report.newListings++; }
  }
  return { report, changed: [...changed].map(id => work.get(id)) };
}
