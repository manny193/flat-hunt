// One serializer for listings, by role. The public view is an allowlist built server-side, so phone
// numbers, map links, WhatsApp/tel links, emails, society names, author names and Facebook post URLs never reach a
// browser that is not signed in (or not yet approved). Group names are kept.

// Phones in public post text become this token (no digits at all); the UI renders it as the hatched
// "number hidden" pill (docs/DESIGN.md).
export const PHONE_TOKEN = '[[phone]]';
// Indian mobiles, optionally +91 / 91 / 0 prefixed, digits optionally split by up to 3 separator
// characters (spaces, newlines, dots, dashes, slashes, underscores, brackets, zero-width characters),
// so "98765 - 43210" and "98765 / 43210" are caught too. Run it through maskPhones(), which also reads
// non-ASCII digits (Devanagari, full-width, mathematical) as digits.
const SEP = '[\\s.\\-/_\u2013\u2014()\u200b-\u200d\u2060\ufeff]';
export const PHONE_ANY = new RegExp(`(?<!\\d)(?:\\+?${SEP}{0,3}91${SEP}{0,3}|0)?([6-9](?:${SEP}{0,3}\\d){9})(?!\\d)`, 'g');
/** Same-length copy of s with every Unicode decimal digit as ASCII (astral digits padded with a zero-width space). */
function asciiDigits(s) {
  return s.replace(/\p{Nd}/gu, ch => { const d = String(Number.isNaN(+ch) ? digitValue(ch) : +ch); return ch.length === 2 ? d + '\u200b' : d; });
}
function digitValue(ch) {
  // Unicode decimal digits come in contiguous blocks of ten starting at a code point ending in 0 or 6;
  // find the block start by stepping back while the previous code point is still a digit.
  let cp = ch.codePointAt(0), n = 0;
  while (n < 9 && /\p{Nd}/u.test(String.fromCodePoint(cp - 1))) { cp--; n++; }
  return n;
}
/** Replace every mobile number in s with token, whatever digits or separators it is written with. */
export function maskPhones(s, token = PHONE_TOKEN) {
  s = String(s ?? ''); const n = asciiDigits(s);
  let out = '', last = 0;
  for (const m of n.matchAll(PHONE_ANY)) {
    let end = m.index + m[0].length; const c = s.charCodeAt(end);
    if (c >= 0xdc00 && c <= 0xdfff) end++; // don't split an astral digit's surrogate pair
    out += s.slice(last, m.index) + token; last = end;
  }
  return out + s.slice(last);
}
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Links people paste without a scheme.
const BARE_LINK = /\b(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|maps\.app\.goo\.gl|goo\.gl|g\.co|m\.me|fb\.me|fb\.com|(?:[a-z0-9-]+\.)?facebook\.com|google\.[a-z.]{2,8}\/maps|maps\.google\.[a-z.]{2,8})(?:\/[^\s<>"']*)?/gi;
const TEL = /\b(?:tel|callto|whatsapp|sms):[^\s<>"']*/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Text safe for the public view: links and emails removed, phone numbers replaced by PHONE_TOKEN. */
export function publicText(s, hide = []) {
  let t = String(s ?? '');
  for (const h of hide) if (h && h.length >= 4) t = t.split(h).join('[society]');
  return maskPhones(t
    .replace(LINK, '[link]').replace(TEL, '[link]').replace(BARE_LINK, '[link]').replace(EMAIL, '[email]'));
}

const PUBLIC_SCALARS = ['id', 'kind', 'bhk', 'rent', 'type', 'deposit', 'depositMonths', 'maintenance', 'brokerage', 'brokerageAmount',
  'furnishing', 'gender', 'availableFrom', 'firstPostedAt', 'lastPostedAt', 'seenCount'];
const img = u => typeof u === 'string' && /^https:\/\/(?:[a-z0-9.-]+\.fbcdn\.net|i\.redd\.it|preview\.redd\.it)\//i.test(u);

/**
 * Public listing. maxPosts limits how many posts (latest first) are included: list views send 1 to
 * keep the response and the masking CPU small; the detail view sends all (up to 15).
 */
export function publicListing(l, { maxPosts = 1 } = {}) {
  const out = {};
  for (const k of PUBLIC_SCALARS) if (l[k] !== undefined && l[k] !== null) out[k] = l[k];
  out.hasPhone = Array.isArray(l.phones) && l.phones.length > 0; // society is hidden too (DESIGN.md)
  out.areas = Array.isArray(l.areas) ? l.areas.filter(Number.isInteger) : [];
  out.groups = (Array.isArray(l.groups) ? l.groups : []).slice(0, 10).map(g => publicText(g));
  out.rentHistory = (Array.isArray(l.rentHistory) ? l.rentHistory : []).map(h => ({ rent: h.rent, at: h.at }));
  const posts = Array.isArray(l.posts) ? l.posts : [];
  const hide = typeof l.society === 'string' ? [l.society] : [];
  out.postCount = posts.length;
  out.posts = posts.slice(0, maxPosts).map(p => ({
    id: p.id, group: publicText(p.group || ''), text: publicText(p.text || '', hide), postedAt: p.postedAt ?? null, timeText: p.timeText || '',
    images: (p.images || []).filter(img).slice(0, 10),
  }));
  out.images = [...new Set(posts.flatMap(p => (p.images || []).filter(img)))].slice(0, 10);
  out.limited = true; // tells the UI that contact details need sign-in
  return out;
}

/** Signed-in view: everything, minus storage internals. */
export function fullListing(l) {
  const { fp, sk, ...rest } = l;
  return rest;
}

/** The single entry point: role 'public' or 'pending' gets the public allowlist. */
export function serializeListing(l, role, opts) {
  return role === 'user' || role === 'admin' ? fullListing(l) : publicListing(l, opts);
}
