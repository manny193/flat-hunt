// Node entry: node:http -> the same Fetch handler as the Worker, node:sqlite storage, web/ served statically.
//   PORT (8787), HOST (0.0.0.0), DB_PATH (./data/flat-hunt.db), CRON_ENABLED=1 + APIFY_TOKEN for the in-process
//   hourly job (CRON_INTERVAL_MINUTES, default 60; runs start when due per the admin schedule), TRUST_PROXY=1 behind a reverse proxy, AUTH_DISABLED=1 for local dev.
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { ALERT_CRON } from './alerts.js';
import { sqliteDriver } from './db/drivers.js';
import { openSqlite, migrateSqlite } from './db/node-sqlite.js';
import { loadMigrations } from './db/fs-migrations.js';
import { createRepo } from './db/repo.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

/** Static files from web/, like Workers Static Assets: "/" -> index.html, "/x" -> x.html when present. */
export function staticAssets(root = WEB_DIR) {
  const base = resolve(root);
  return async request => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = resolve(base, '.' + normalize('/' + p));
    if (!file.startsWith(base + '/') && file !== base) return null;
    for (const f of [file, extname(file) ? null : file + '.html'].filter(Boolean)) {
      try {
        const st = await stat(f); if (!st.isFile()) continue;
        const type = MIME[extname(f)] || 'application/octet-stream';
        const body = request.method === 'HEAD' ? null : await readFile(f);
        return new Response(body, { headers: { 'content-type': type, 'content-length': String(st.size), 'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300' } });
      } catch { /* try next */ }
    }
    return null;
  };
}

/** node:http request -> Fetch Request. Exported for tests. */
export function toRequest(req, env) {
  const proto = env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const url = `${proto}://${req.headers.host || 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith(':')) continue;
    if (k === 'cf-connecting-ip') continue; // set below from the socket, never trusted from the client
    if (k.startsWith('cf-access-') && env.AUTH_MODE !== 'cloudflare-access') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  // The proxy we trust appends the address it saw, so the client is the *last* entry; anything to its
  // left was sent by the client and would let it pick a fresh "IP" per login attempt.
  const fwd = env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean).pop() || '' : '';
  headers.set('cf-connecting-ip', fwd || req.socket.remoteAddress || 'unknown');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined });
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

/** Start the server. Returns {server, url, repo, close}. Used by `npm start`, tests and the e2e script. */
export async function startServer(opts = {}) {
  const env = { ...process.env, ...(opts.env || {}), RUNTIME: 'node' };
  const dbPath = opts.dbPath ?? env.DB_PATH ?? './data/flat-hunt.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const raw = await openSqlite(dbPath);
  const applied = migrateSqlite(raw, loadMigrations());
  if (applied.length && !opts.quiet) console.log('migrations applied:', applied.join(', '));
  const repo = createRepo(sqliteDriver(raw));
  const app = createApp({ repo: () => repo, assets: staticAssets(opts.webDir), fetch: opts.fetch });

  const server = http.createServer(async (req, res) => {
    try { await send(res, await app.fetch(toRequest(req, env), env, {})); }
    catch (e) { console.error('server error', e); if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Internal error'); }
  });
  server.headersTimeout = 20e3; server.requestTimeout = 60e3;

  let timer = null;
  if (env.CRON_ENABLED === '1' && env.APIFY_TOKEN) {
    const minutes = Math.max(15, parseInt(env.CRON_INTERVAL_MINUTES, 10) || 60);
    const run = () => app.scheduled({ cron: 'node-interval', scheduledTime: Date.now() }, env).catch(e => console.error('scheduled job failed', e));
    const first = setTimeout(run, 2 * 60e3); first.unref();
    timer = setInterval(run, minutes * 60e3); timer.unref();
    if (!opts.quiet) console.log(`scheduler: every ${minutes} min (first run in 2 min)`);
  }

  // Area alerts (docs/ai/ALERTS-WEBPUSH.md): the 10-minute send step, like the Worker's second Cron Trigger.
  let alertTimer = null;
  if (env.CRON_ENABLED === '1' && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    alertTimer = setInterval(() => app.scheduled({ cron: ALERT_CRON, scheduledTime: Date.now() }, env).catch(e => console.error('alert step failed', e?.message || e)), 10 * 60e3); alertTimer.unref();
    if (!opts.quiet) console.log('alerts: send step every 10 min');
  }

  const port = opts.port ?? (parseInt(env.PORT, 10) || 8787);
  const host = opts.host ?? env.HOST ?? '0.0.0.0';
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  const addr = server.address();
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`;
  const close = () => new Promise(ok => { clearInterval(timer); clearInterval(alertTimer); server.close(() => { try { raw.close(); } catch { /* already closed */ } ok(); }); server.closeAllConnections?.(); });
  return { server, url, repo, close, env };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const s = await startServer();
  const mode = s.env.APP_PASSWORD && s.env.SESSION_SECRET ? 'password login' : s.env.AUTH_DISABLED === '1' ? 'AUTH DISABLED (local dev only)' : 'login NOT configured: API returns 503';
  console.log(`Flat Hunt on ${s.url} (${mode})`);
  let stopping = false;
  const stop = sig => { if (stopping) return; stopping = true; console.log(`${sig}: shutting down`); const force = setTimeout(() => process.exit(1), 8000); force.unref(); s.close().then(() => process.exit(0)); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
