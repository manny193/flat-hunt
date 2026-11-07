// The whole app as one Fetch handler: auth gate, JSON API, webhook, health, static assets.
// Platform adapters (src/worker.js, src/node-server.js) supply the repository and a static file server.

import { HttpError, json, errorJson, readJson, safeEqual, secure } from './http.js';
import { authenticate, authMode, attemptLogin, clearCookie } from './auth.js';
import { ingestItems } from './ingest.js';
import { ingestDataset, isDatasetId, scheduledJob, actorId, DEFAULT_RESULTS_PER_GROUP } from './apify.js';
import { generateKeywords, cleanKeywords } from './core/keywords.js';
import { esc } from './core/logic.js';
import { STAGES, STATUSES } from './db/repo.js';

const KB = 1024;
export const LIMITS = { importBytes: 2 * KB * KB, webhookBytes: 16 * KB, smallBytes: 64 * KB, importItems: 3000 };
const IMPORT_SOURCES = ['scraper', 'phone', 'manual', 'sample'];
// Paths reachable without a session. Static files here hold no data: the login page needs the
// stylesheet and icon, and browsers fetch the web manifest without cookies.
const PUBLIC_ASSETS = new Set(['/app.css', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest', '/favicon.ico']);

/**
 * @param deps {repo(env) -> repository, assets(request, env) -> Response|null, fetch?}
 */
export function createApp(deps) {
  const fetchFn = deps.fetch || ((...a) => fetch(...a));
  return {
    async fetch(request, env, ctx) {
      let res;
      try { res = await route(request, env, ctx, deps, fetchFn); }
      catch (e) {
        if (e instanceof HttpError) res = errorJson(e.status, e.code, e.message, e.extra);
        else { console.error('request failed', request.method, new URL(request.url).pathname, e && e.stack || e); res = errorJson(500, 'internal', 'Something went wrong on the server.'); }
      }
      return secure(res);
    },
    async scheduled(event, env) {
      const repo = deps.repo(env);
      const r = await scheduledJob(repo, env, { fetchFn });
      console.log('scheduled', JSON.stringify({ action: r.action, swept: r.swept?.length, detail: r.detail }));
      return r;
    },
  };
}

async function route(request, env, ctx, deps, fetchFn) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  const repo = () => deps.repo(env);

  // ---------- public ----------
  if (path === '/healthz' || path === '/api/health') return health(repo());
  if (path === '/api/ingest/apify') {
    if (method !== 'POST') return errorJson(405, 'method_not_allowed');
    return webhook(request, env, repo(), fetchFn);
  }
  if (path === '/login' && method === 'GET') {
    const who = await authenticate(request, env, fetchFn);
    if (who.user) return redirect(safeNext(url.searchParams.get('next')));
    return loginPage(authMode(env), url.searchParams.get('error'), safeNext(url.searchParams.get('next')));
  }
  if (path === '/api/login') {
    if (method !== 'POST') return errorJson(405, 'method_not_allowed');
    checkOrigin(request);
    return login(request, env, repo());
  }
  if (path === '/api/logout' && method === 'POST') { checkOrigin(request); return new Response(null, { status: 204, headers: { 'set-cookie': clearCookie() } }); }
  if ((method === 'GET' || method === 'HEAD') && PUBLIC_ASSETS.has(path)) return (await deps.assets(request, env)) || errorJson(404, 'not_found');

  // ---------- everything else needs a session ----------
  const who = await authenticate(request, env, fetchFn);
  if (!who.user) {
    if (who.mode === 'unconfigured') return errorJson(503, 'auth_not_configured', 'Login is not configured on the server: set APP_PASSWORD and SESSION_SECRET.');
    if (path.startsWith('/api/')) return errorJson(401, 'unauthenticated', 'Log in to continue.', { login: '/login' });
    if (method === 'GET' && (request.headers.get('accept') || '').includes('text/html')) return redirect('/login' + (path !== '/' ? '?next=' + encodeURIComponent(path + url.search) : ''));
    return errorJson(401, 'unauthenticated');
  }

  if (path.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(method)) checkOrigin(request);
    return api(request, env, method, path, url, repo(), fetchFn);
  }
  if (method !== 'GET' && method !== 'HEAD') return errorJson(405, 'method_not_allowed');
  return (await deps.assets(request, env)) || errorJson(404, 'not_found');
}

// ---------- helpers ----------
const redirect = (to, status = 302) => new Response(null, { status, headers: { location: to } });
const safeNext = n => (typeof n === 'string' && /^\/(?!\/)[^\s\\]*$/.test(n) && !n.startsWith('/login')) ? n : '/';
/** State-changing requests must come from our own pages (CSRF defence on top of SameSite=Lax). */
// Prefers Sec-Fetch-Site (all current browsers): with Referrer-Policy: no-referrer a same-origin
// form POST carries `Origin: null`, so Origin alone can't tell friend from foe.
function checkOrigin(request) {
  const refuse = () => { throw new HttpError(403, 'bad_origin', 'Cross-site request refused.'); };
  const site = request.headers.get('sec-fetch-site');
  if (site) { if (site !== 'same-origin' && site !== 'none') refuse(); return; }
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return; // non-browser client or opaque origin; SameSite=Lax still applies
  let host; try { host = new URL(origin).host; } catch { host = ''; }
  if (host !== new URL(request.url).host) refuse();
}
const int = v => (v != null && /^\d{1,15}$/.test(String(v)) ? Number(v) : null);
const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : null;

async function health(repo) {
  try {
    const t = await repo.lastIngestAt();
    return json({ ok: true, lastIngestAgeMin: t ? Math.round((Date.now() - t) / 60e3) : null });
  } catch (e) {
    console.error('health check failed', e);
    return json({ ok: false, error: 'db_unavailable' }, 503);
  }
}

async function webhook(request, env, repo, fetchFn) {
  if (!env.INGEST_SECRET) return errorJson(503, 'ingest_disabled', 'INGEST_SECRET is not set.');
  if (!(await safeEqual(request.headers.get('x-ingest-secret') || '', env.INGEST_SECRET))) return errorJson(401, 'bad_secret', 'Invalid ingest secret.');
  const body = await readJson(request, LIMITS.webhookBytes);
  const datasetId = body?.datasetId ?? body?.resource?.defaultDatasetId;
  const runId = body?.runId ?? body?.resource?.id ?? null;
  if (body?.eventType && body.eventType !== 'ACTOR.RUN.SUCCEEDED') return json({ status: 'ignored', reason: 'event ' + String(body.eventType).slice(0, 40) }, 202);
  if (!isDatasetId(datasetId)) return errorJson(400, 'bad_dataset_id', 'datasetId is missing or malformed.');
  if (runId != null && !/^[A-Za-z0-9]{6,40}$/.test(String(runId))) return errorJson(400, 'bad_run_id');
  if (!env.APIFY_TOKEN) return errorJson(503, 'apify_not_configured', 'APIFY_TOKEN is not set.');
  const res = await ingestDataset(repo, env, { datasetId, runId: runId && String(runId) }, { fetchFn });
  return json(res.status === 'skipped' ? { status: 'skipped', reason: res.reason } : { status: 'done', report: res.report });
}

async function login(request, env, repo) {
  const form = (request.headers.get('content-type') || '').startsWith('application/x-www-form-urlencoded');
  let password, next = '/';
  if (form) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > 4 * KB) throw new HttpError(413, 'payload_too_large');
    const text = await request.text(); if (text.length > 4 * KB) throw new HttpError(413, 'payload_too_large');
    const p = new URLSearchParams(text); password = p.get('password') || ''; next = safeNext(p.get('next'));
  } else {
    const body = await readJson(request, 4 * KB); password = body?.password;
  }
  const r = await attemptLogin(request, env, repo, password);
  if (form) {
    if (r.ok) return new Response(null, { status: 303, headers: { location: next, 'set-cookie': r.cookie } });
    const err = r.status === 429 ? 'locked' : r.status === 503 ? 'unconfigured' : 'wrong';
    return redirect(`/login?error=${err}${next !== '/' ? '&next=' + encodeURIComponent(next) : ''}`, 303);
  }
  if (r.ok) return new Response(null, { status: 204, headers: { 'set-cookie': r.cookie } });
  if (r.status === 429) return json({ error: 'too_many_attempts', message: 'Too many wrong passwords. Try again in 15 minutes.' }, 429, { 'retry-after': String(r.retryAfter) });
  if (r.status === 503) return errorJson(503, 'auth_not_configured', 'Login is not configured on the server.');
  return errorJson(401, 'wrong_password', 'That password is not right.');
}

function loginPage(mode, error, next) {
  const msg = { wrong: 'That password is not right.', locked: 'Too many wrong passwords. Try again in 15 minutes.', unconfigured: 'Login is not configured on the server.' }[error] || '';
  const body = mode === 'unconfigured' || mode === 'cloudflare-access' && !msg
    ? `<p class="help">${mode === 'unconfigured' ? 'Login is not configured on the server. Set APP_PASSWORD and SESSION_SECRET, then reload.' : 'Sign in through Cloudflare Access to use this app.'}</p>`
    : `<form method="post" action="/api/login" class="login-form">
        <input type="hidden" name="next" value="${esc(next)}">
        <label class="lbl" for="pw">Password</label>
        <input class="input" id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
        ${msg ? `<p class="login-err" role="alert">${esc(msg)}</p>` : ''}
        <button class="btn primary" type="submit">Log in</button>
      </form>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Log in · Flat Hunt</title><meta name="robots" content="noindex"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#D0312D"><link rel="stylesheet" href="/app.css"></head>
<body class="login-page"><main class="login-card"><div class="board"><span class="plate">TO-LET</span><span class="rentbig">Flat Hunt</span><div class="kind">Your flat hunt, sorted</div></div>${body}</main></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ---------- API ----------
async function api(request, env, method, path, url, repo, fetchFn) {
  const seg = path.split('/').slice(2); // after /api
  const [res, id] = seg;
  const now = Date.now();

  if (res === 'listings') {
    if (!id && method === 'GET') {
      const status = url.searchParams.get('status'); const area = url.searchParams.get('area'); const since = url.searchParams.get('since');
      if (status && !STATUSES.includes(status)) throw new HttpError(400, 'bad_status');
      if (area != null && area !== '' && int(area) == null) throw new HttpError(400, 'bad_area');
      if (since != null && since !== '' && int(since) == null) throw new HttpError(400, 'bad_since');
      const listings = await repo.listListings({ status: status || undefined, area: area ? int(area) : undefined, since: since ? int(since) : undefined });
      const out = { now, listings };
      if (since) out.ids = await repo.listingIds(); // lets the client drop listings deleted elsewhere
      return json(out);
    }
    if (!id && method === 'DELETE') {
      const status = url.searchParams.get('status'); const sample = url.searchParams.get('sample') === '1';
      if (!sample && status !== 'rejected') throw new HttpError(400, 'bad_filter', 'Bulk delete supports ?status=rejected or ?sample=1.');
      const ids = await repo.idsWhere({ status, sample });
      return json({ deleted: await repo.deleteListings(ids), ids });
    }
    if (id && seg.length === 2) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'bad_id');
      if (method === 'GET') { const l = await repo.getListing(id); return l ? json(l) : errorJson(404, 'not_found'); }
      if (method === 'DELETE') return (await repo.deleteListings([id])) ? new Response(null, { status: 204 }) : errorJson(404, 'not_found');
      if (method === 'PATCH') return json(await patchListing(repo, id, await readJson(request, LIMITS.smallBytes), now));
    }
  }

  if (res === 'import' && !id && method === 'POST') {
    const body = await readJson(request, LIMITS.importBytes);
    const source = IMPORT_SOURCES.includes(body?.source) ? body.source : null;
    if (!source) throw new HttpError(400, 'bad_source', `source must be one of ${IMPORT_SOURCES.join(', ')}.`);
    if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'no_items', 'items must be a non-empty array.');
    if (body.items.length > LIMITS.importItems) throw new HttpError(413, 'too_many_items', `At most ${LIMITS.importItems} posts per import.`);
    const items = body.items.filter(x => typeof x === 'string' || (x && typeof x === 'object' && !Array.isArray(x)));
    const { report, changed } = await ingestItems(repo, items, { source, now, sample: source === 'sample' });
    return json({ report, changed: changed.length });
  }

  if (res === 'settings' && !id) {
    if (method === 'GET') return json(await settingsView(repo, env));
    if (method === 'PUT') { await repo.putSettings(validateSettings(await readJson(request, LIMITS.smallBytes))); return json(await settingsView(repo, env)); }
  }

  if (res === 'areas') {
    if (!id && method === 'GET') return json({ areas: await repo.listAreas() });
    if (!id && method === 'POST') {
      const b = await readJson(request, LIMITS.smallBytes);
      const name = areaName(b?.name);
      const keywords = b?.keywords != null ? cleanKeywords(b.keywords) : generateKeywords(name);
      if (!keywords.length) throw new HttpError(400, 'no_keywords', 'That name gives no usable keywords. Use at least 3 letters.');
      if ((await repo.listAreas()).some(a => a.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'duplicate_area', 'You already have an area with that name.');
      return json(await repo.createArea({ name, keywords, active: b?.active !== false }, now), 201);
    }
    if (id && seg.length === 2) {
      const aid = int(id); if (aid == null) throw new HttpError(400, 'bad_id');
      const cur = await repo.getArea(aid); if (!cur) return errorJson(404, 'not_found');
      if (method === 'DELETE') { await repo.deleteArea(aid); return new Response(null, { status: 204 }); }
      if (method === 'PATCH') {
        const b = await readJson(request, LIMITS.smallBytes);
        const name = b?.name != null ? areaName(b.name) : cur.name;
        if (name.toLowerCase() !== cur.name.toLowerCase() && (await repo.listAreas()).some(a => a.id !== aid && a.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'duplicate_area', 'You already have an area with that name.');
        const keywords = b?.regenerate ? generateKeywords(name) : b?.keywords != null ? cleanKeywords(b.keywords) : cur.keywords;
        if (!keywords.length) throw new HttpError(400, 'no_keywords', 'Keep at least one keyword of 3 or more letters.');
        const active = typeof b?.active === 'boolean' ? b.active : cur.active;
        return json(await repo.updateArea(aid, { name, keywords, active }));
      }
    }
  }

  if (res === 'keywords' && !id && method === 'GET') return json({ keywords: generateKeywords(areaName(url.searchParams.get('name'))) });
  if (res === 'runs' && !id && method === 'GET') return json({ runs: await repo.listRuns(20) });
  if (res === 'apify' && id === 'run' && method === 'POST') {
    if (!env.APIFY_TOKEN) throw new HttpError(503, 'apify_not_configured', 'APIFY_TOKEN is not set on the server.');
    return json(await scheduledJob(repo, env, { fetchFn }));
  }
  if (res === 'export' && !id && method === 'GET') {
    const [listings, areas, settings] = await Promise.all([repo.listListings(), repo.listAreas(), repo.getSettings()]);
    return new Response(JSON.stringify({ exportedAt: new Date(now).toISOString(), areas, settings: { groups: settings.groups || [], keywordFilter: settings.keywordFilter !== false }, listings }, null, 1), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="flat-hunt-${new Date(now).toISOString().slice(0, 10)}.json"` },
    });
  }
  return errorJson(404, 'not_found', 'No such API route.');
}

async function patchListing(repo, id, b, now) {
  const cur = await repo.getListing(id);
  if (!cur) throw new HttpError(404, 'not_found');
  if (!b || typeof b !== 'object') throw new HttpError(400, 'bad_body');
  const next = { status: cur.status, stage: cur.stage, notes: cur.notes, decidedAt: cur.decidedAt, hasUpdate: cur.hasUpdate };
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw new HttpError(400, 'bad_status', `status must be one of ${STATUSES.join(', ')}.`);
    if (b.status !== cur.status) { next.status = b.status; next.decidedAt = now; next.hasUpdate = false; }
  }
  if (b.stage !== undefined) {
    if (b.stage !== '' && !STAGES.includes(b.stage)) throw new HttpError(400, 'bad_stage', 'Unknown stage.');
    next.stage = b.stage;
  }
  if (next.status === 'approved' && !next.stage) next.stage = STAGES[0];
  if (b.notes !== undefined) { if (typeof b.notes !== 'string' || b.notes.length > 5000) throw new HttpError(400, 'bad_notes', 'Notes must be text under 5,000 characters.'); next.notes = b.notes; }
  // Undo restores the previous decision time; only accept a plausible timestamp or null.
  if (b.decidedAt !== undefined) { if (b.decidedAt !== null && !(Number.isInteger(b.decidedAt) && b.decidedAt > 0 && b.decidedAt <= now + 60e3)) throw new HttpError(400, 'bad_decided_at'); next.decidedAt = b.decidedAt; }
  if (b.hasUpdate === false) next.hasUpdate = false;
  return repo.updateListingFields(id, next, now);
}

function areaName(v) {
  const name = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'bad_name', 'Area name must be 2 to 60 characters.');
  return name;
}

function validateSettings(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'bad_body');
  const out = {};
  if (b.groups !== undefined) {
    if (!Array.isArray(b.groups) || b.groups.length > 50) throw new HttpError(400, 'bad_groups', 'groups must be a list of at most 50.');
    out.groups = b.groups.map((g, i) => {
      const name = (str(g?.name, 120) || '').trim(); const raw = (str(g?.url, 300) || '').trim();
      let u; try { u = new URL(raw); } catch { throw new HttpError(400, 'bad_group_url', `Group ${i + 1}: paste the full link, like https://www.facebook.com/groups/123.`); }
      if (u.protocol !== 'https:' || !/(^|\.)facebook\.com$/i.test(u.hostname) || !/^\/groups\/[^/]+/.test(u.pathname)) throw new HttpError(400, 'bad_group_url', `Group ${i + 1}: use a facebook.com/groups/… link.`);
      return { name, url: `https://www.facebook.com${u.pathname.replace(/\/+$/, '')}`, active: g?.active !== false };
    });
  }
  if (b.keywordFilter !== undefined) { if (typeof b.keywordFilter !== 'boolean') throw new HttpError(400, 'bad_keyword_filter'); out.keywordFilter = b.keywordFilter; }
  if (b.resultsPerGroup !== undefined) { const n = Number(b.resultsPerGroup); if (!Number.isInteger(n) || n < 5 || n > 100) throw new HttpError(400, 'bad_results_per_group', 'Posts per group must be 5 to 100.'); out.resultsPerGroup = n; }
  if (!Object.keys(out).length) throw new HttpError(400, 'nothing_to_update');
  return out;
}

async function settingsView(repo, env) {
  const s = await repo.getSettings();
  let actor = null; try { actor = actorId(env); } catch { actor = 'invalid'; }
  return {
    groups: Array.isArray(s.groups) ? s.groups : [],
    keywordFilter: s.keywordFilter !== false,
    resultsPerGroup: s.resultsPerGroup || DEFAULT_RESULTS_PER_GROUP,
    apifyUsage: s.apifyUsage || null,
    scheduler: s.scheduler || null,
    unscrapableGroups: s.unscrapableGroups || null,
    apify: { configured: !!env.APIFY_TOKEN, actor, webhook: !!(env.PUBLIC_BASE_URL && env.INGEST_SECRET), webhookUrl: env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/ingest/apify' : null },
    auth: authMode(env),
  };
}
