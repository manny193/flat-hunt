// Small HTTP helpers shared by the Worker and the Node adapter (Fetch-standard Request/Response).

export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.fbcdn.net",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** Copy a response, adding security headers (and no-store for HTML and API responses). */
export function secure(res, { noStore = false } = {}) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  const ct = h.get('content-type') || '';
  if (noStore || ct.includes('text/html') || ct.includes('application/json')) h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
export const errorJson = (status, code, message, extra) => json({ error: code, message: message || code, ...(extra || {}) }, status);

/** Read a JSON body with a hard byte cap, streaming so an oversized body is never fully buffered. */
export async function readJson(request, maxBytes) {
  const ct = request.headers.get('content-type') || '';
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'payload_too_large', `Body is larger than ${Math.round(maxBytes / 1024)} KB.`);
  if (!request.body) throw new HttpError(400, 'bad_json', 'Empty body.');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new HttpError(413, 'payload_too_large', `Body is larger than ${Math.round(maxBytes / 1024)} KB.`); }
    chunks.push(value);
  }
  const buf = new Uint8Array(size); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { throw new HttpError(400, 'bad_json', 'Body is not valid JSON.'); }
}

/** Constant-time string comparison (compares SHA-256 digests so lengths don't leak). */
export async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0 && a.length === b.length;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}
export const clientIp = request => request.headers.get('cf-connecting-ip') || 'unknown';
