// Accounts and roles: Google sign-in (mocked Google), break-glass password, per-user state,
// public serializer (no contact details leak), rate limit, admin API, migration safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createUserSession, COOKIE } from '../src/auth.js';
import { resetGoogleKeys, GOOGLE_TOKEN_URL, GOOGLE_JWKS_URL, OAUTH_COOKIE } from '../src/google.js';
import { publicText, publicListing, PHONE_ANY } from '../src/serialize.js';
import { openSqlite, migrateSqlite } from '../src/db/node-sqlite.js';
import { loadMigrations } from '../src/db/fs-migrations.js';
import { sqliteDriver } from '../src/db/drivers.js';
import { createRepo } from '../src/db/repo.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const BASE = 'https://hunt.test';
const ENV = { RUNTIME: 'worker', SESSION_SECRET: 'session-secret-0123456789abcdef0123', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'gsecret', PUBLIC_BASE_URL: 'https://hunt.test', ADMIN_EMAILS: 'boss@example.com' };
const b64u = b => Buffer.from(b).toString('base64url');

async function googleFixture() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' };
  const sign = async claims => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'g1', typ: 'JWT' })), p = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p));
    return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
  };
  const state = { claims: null, tokenCalls: [], jwksCalls: 0, idToken: null };
  const fetchFn = async (url, init = {}) => {
    if (url === GOOGLE_JWKS_URL) { state.jwksCalls++; return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'public, max-age=20000' } }); }
    if (url === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(init.body); state.tokenCalls.push(form);
      return Response.json({ id_token: state.idToken || await sign({ ...state.claims, nonce: state.claims.nonce ?? state.nonce }), access_token: 'x', token_type: 'Bearer' });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { sign, fetchFn, state };
}

async function harness(envOver = {}, fx) {
  const t = await memoryDb();
  const app = createApp({ repo: () => t.repo, assets: async () => null, fetch: fx?.fetchFn });
  const env = { ...ENV, ...envOver };
  const call = (method, path, { body, headers = {} } = {}) => app.fetch(new Request(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
  const jcall = async (...a) => { const r = await call(...a); const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; } return { status: r.status, data, headers: r.headers }; };
  const sessionFor = async (email, role = 'user', status = 'active') => {
    const u = await t.repo.upsertUser({ email, name: email.split('@')[0], role, status }, Date.now());
    return { user: u, cookie: `${COOKIE}=${await createUserSession(env, u.id, role)}` };
  };
  return { ...t, app, env, call, jcall, sessionFor };
}
const cookies = res => res.headers.getSetCookie().map(c => c.split(';')[0]);

/** Run the whole Google flow; returns the callback response. */
async function googleLogin(h, fx, claims, { tamper } = {}) {
  const start = await h.call('GET', '/auth/google?next=%2F%23shortlist');
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  const flow = cookies(start).find(c => c.startsWith(OAUTH_COOKIE + '='));
  fx.state.nonce = loc.searchParams.get('nonce');
  fx.state.claims = { iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, sub: '123', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), name: 'Test', ...claims };
  const st = tamper === 'state' ? 'wrong-state' : loc.searchParams.get('state');
  return h.call('GET', `/auth/google/callback?code=4%2Fabc&state=${encodeURIComponent(st)}`, { headers: { cookie: tamper === 'nocookie' ? '' : flow } });
}

test('Google sign-in: PKCE + state + nonce redirect, code exchange, verified id_token creates a user session', async () => {
  resetGoogleKeys();
  const fx = await googleFixture(); const h = await harness({}, fx);
  const start = await h.call('GET', '/auth/google');
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  for (const k of ['state', 'nonce', 'code_challenge']) assert.ok(loc.searchParams.get(k)?.length >= 32, k);
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://hunt.test/auth/google/callback');
  assert.equal(loc.searchParams.get('scope'), 'openid email profile');
  assert.match(start.headers.get('set-cookie'), /^__Host-flat-hunt-oauth=[^;]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);

  const cb = await googleLogin(h, fx, { email: 'Asha@Example.com' });
  assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/#shortlist');
  const form = fx.state.tokenCalls.at(-1);
  assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('client_secret'), 'gsecret');
  assert.ok(form.get('code_verifier').length >= 43, 'PKCE verifier sent');
  const session = cookies(cb).find(c => c.startsWith(COOKIE + '='));
  assert.ok(session);
  const me = await h.jcall('GET', '/api/me', { headers: { cookie: session } });
  assert.equal(me.data.role, 'user'); assert.equal(me.data.user.email, 'asha@example.com');
  assert.equal((await h.call('GET', '/api/listings', { headers: { cookie: session } })).status, 200);
  assert.equal((await h.call('GET', '/api/admin/runs', { headers: { cookie: session } })).status, 403, 'users are not admins');
  assert.equal(fx.state.jwksCalls, 1);
  await googleLogin(h, fx, { email: 'asha@example.com' });
  assert.equal(fx.state.jwksCalls, 1, 'JWKS cached');
});

test('Google sign-in rejects bad state, missing flow cookie, wrong nonce/aud/iss, expiry, unverified email, bad signature', async () => {
  resetGoogleKeys();
  const fx = await googleFixture(); const h = await harness({}, fx);
  const err = r => new URL(r.headers.get('location'), BASE).searchParams.get('error');
  assert.equal(err(await googleLogin(h, fx, { email: 'a@example.com' }, { tamper: 'state' })), 'google_state');
  assert.equal(err(await googleLogin(h, fx, { email: 'a@example.com' }, { tamper: 'nocookie' })), 'google_expired');
  for (const [claims, code] of [[{ nonce: 'other' }, 'google_failed'], [{ aud: 'someone-else' }, 'google_failed'], [{ iss: 'https://evil.example' }, 'google_failed'], [{ exp: Math.floor(Date.now() / 1000) - 600 }, 'google_failed'], [{ email_verified: false }, 'google_unverified']]) {
    const r = await googleLogin(h, fx, { email: 'a@example.com', ...claims });
    assert.equal(err(r), code, JSON.stringify(claims));
    assert.ok(!cookies(r).some(c => c.startsWith(COOKIE + '=') && c.length > COOKIE.length + 1), 'no session on failure');
  }
  fx.state.idToken = (await fx.sign({ iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, email: 'a@example.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, nonce: 'x' })).slice(0, -6) + 'AAAAAA';
  assert.equal(err(await googleLogin(h, fx, {})), 'google_failed', 'bad signature');
  assert.equal((await h.repo.listUsers()).length, 0);
  assert.equal((await (await harness({ GOOGLE_CLIENT_ID: '' })).call('GET', '/auth/google')).headers.get('location'), '/login?error=google_unconfigured');
});

test('roles: ADMIN_EMAILS are admins, approval gate makes new users pending, block and demote take effect immediately', async () => {
  resetGoogleKeys();
  const fx = await googleFixture(); const h = await harness({}, fx);
  const admin = cookies(await googleLogin(h, fx, { email: 'boss@example.com' })).find(c => c.startsWith(COOKIE));
  assert.equal((await h.jcall('GET', '/api/me', { headers: { cookie: admin } })).data.role, 'admin');
  assert.equal((await h.jcall('PUT', '/api/admin/settings', { body: { requireApproval: true }, headers: { cookie: admin } })).data.requireApproval, true);
  const cb = await googleLogin(h, fx, { email: 'new@example.com' });
  assert.equal(cb.headers.get('location'), '/login?error=pending');
  const pending = cookies(cb).find(c => c.startsWith(COOKIE));
  assert.equal((await h.jcall('GET', '/api/me', { headers: { cookie: pending } })).data.role, 'pending');
  assert.equal((await h.call('GET', '/api/listings', { headers: { cookie: pending } })).status, 403);
  assert.equal((await h.call('GET', '/api/public/listings', { headers: { cookie: pending } })).status, 200, 'pending users still browse publicly');
  const users = (await h.jcall('GET', '/api/admin/users', { headers: { cookie: admin } })).data.users;
  const nu = users.find(u => u.email === 'new@example.com');
  await h.jcall('PATCH', `/api/admin/users/${nu.id}`, { body: { status: 'active' }, headers: { cookie: admin } });
  assert.equal((await h.call('GET', '/api/listings', { headers: { cookie: pending } })).status, 200, 'approval applies to the existing session');
  await h.jcall('PATCH', `/api/admin/users/${nu.id}`, { body: { role: 'admin' }, headers: { cookie: admin } });
  assert.equal((await h.call('GET', '/api/admin/runs', { headers: { cookie: pending } })).status, 200, 'promotion applies at once');
  await h.jcall('PATCH', `/api/admin/users/${nu.id}`, { body: { role: 'user', status: 'blocked' }, headers: { cookie: admin } });
  assert.equal((await h.call('GET', '/api/listings', { headers: { cookie: pending } })).status, 401, 'blocked = signed out');
  assert.equal(new URL((await googleLogin(h, fx, { email: 'new@example.com' })).headers.get('location'), BASE).searchParams.get('error'), 'blocked');
  const me = users.find(u => u.email === 'boss@example.com');
  assert.equal((await h.call('PATCH', `/api/admin/users/${me.id}`, { body: { role: 'user' }, headers: { cookie: admin } })).status, 400, 'no self-demotion');
});

test('break-glass password login is an admin and inherits the legacy global state once', async () => {
  const h = await harness({ APP_PASSWORD: 'correct horse battery staple', GOOGLE_CLIENT_ID: '' });
  const area = await h.repo.createArea(GREEN_GLEN, Date.now());
  const { ingestItems } = await import('../src/ingest.js');
  await ingestItems(h.repo, [{ text: '2BHK available in Green Glen Layout, rent 30000', url: 'https://www.facebook.com/groups/1/posts/9/' }], { source: 'manual' });
  const [l] = await h.repo.listListings();
  await h.repo.updateListingFields(l.id, { status: 'approved', stage: 'Visited', notes: 'nice', decidedAt: 1, hasUpdate: false }, Date.now());
  const login = await h.call('POST', '/api/login', { body: { password: 'correct horse battery staple' } });
  const cookie = cookies(login)[0];
  const me = await h.jcall('GET', '/api/me', { headers: { cookie } });
  assert.equal(me.data.role, 'admin'); assert.equal(me.data.user.email, 'boss@example.com', 'acts as the first ADMIN_EMAILS account');
  const mine = (await h.jcall('GET', '/api/listings?status=approved', { headers: { cookie } })).data.listings;
  assert.equal(mine.length, 1); assert.equal(mine[0].stage, 'Visited'); assert.equal(mine[0].notes, 'nice');
  assert.deepEqual((await h.jcall('GET', '/api/areas', { headers: { cookie } })).data.areas.map(a => a.id), [area.id]);
  assert.equal(await h.repo.adoptLegacyState(999, Date.now()), false, 'only once');
});

test('per-user state: decisions, notes and areas are private to each user', async () => {
  const h = await harness();
  await h.repo.createArea(GREEN_GLEN, Date.now());
  const { ingestItems } = await import('../src/ingest.js');
  await ingestItems(h.repo, [{ text: '2BHK available in Green Glen Layout, rent 30000, call 9000012345', url: 'https://www.facebook.com/groups/1/posts/1/' }, { text: '1BHK in Green Glen Layout for 18k, owner 9000054321', url: 'https://www.facebook.com/groups/1/posts/2/' }], { source: 'apify', storeAll: true });
  const a = await h.sessionFor('a@example.com'), b = await h.sessionFor('b@example.com');
  assert.equal((await h.jcall('POST', '/api/areas', { body: { name: 'green glen' }, headers: { cookie: a.cookie } })).status, 201, 'existing area linked by name');
  assert.equal((await h.jcall('POST', '/api/areas', { body: { name: 'Green Glen' }, headers: { cookie: a.cookie } })).status, 409);
  assert.equal((await h.jcall('GET', '/api/listings', { headers: { cookie: b.cookie } })).data.listings.length, 0, 'b follows no area yet');
  await h.jcall('POST', '/api/areas', { body: { areaId: 1 }, headers: { cookie: b.cookie } });
  const la = (await h.jcall('GET', '/api/listings', { headers: { cookie: a.cookie } })).data.listings;
  assert.equal(la.length, 2); assert.ok(la[0].phones.length, 'signed-in users see phones');
  await h.jcall('PATCH', `/api/listings/${la[0].id}`, { body: { status: 'approved', notes: 'A only' }, headers: { cookie: a.cookie } });
  const lb = (await h.jcall('GET', '/api/listings', { headers: { cookie: b.cookie } })).data.listings;
  assert.ok(lb.every(l => l.status === 'new' && l.notes === ''), 'b unaffected');
  assert.equal((await h.jcall('GET', '/api/listings?status=approved', { headers: { cookie: a.cookie } })).data.listings[0].notes, 'A only');
  // a repost of a's shortlisted listing flags it for a only
  await ingestItems(h.repo, [{ text: '2BHK available in Green Glen Layout, rent 30000, call 9000012345 still available', url: 'https://www.facebook.com/groups/2/posts/1/' }], { source: 'apify', storeAll: true });
  assert.equal((await h.jcall('GET', `/api/listings/${la[0].id}`, { headers: { cookie: a.cookie } })).data.hasUpdate, true);
  assert.equal((await h.jcall('GET', `/api/listings/${la[0].id}`, { headers: { cookie: b.cookie } })).data.hasUpdate, false);
  assert.equal((await h.call('DELETE', `/api/listings/${la[0].id}`, { headers: { cookie: a.cookie } })).status, 403, 'only admins delete shared listings');
  assert.equal((await h.call('PATCH', '/api/areas/1', { body: { keywords: ['x y z'] }, headers: { cookie: a.cookie } })).status, 403, 'only admins edit global keywords');
  assert.equal((await h.call('DELETE', '/api/areas/1', { headers: { cookie: a.cookie } })).status, 204, 'leaving an area');
  assert.equal((await h.repo.listAreas()).length, 1, 'the area itself stays');
});

// ---------- public view never leaks contact details ----------
const LEAKY = [
  'Call 9876543210 now', 'Ph: +91 98765 43210', 'WhatsApp +91-98765-43210', '098765 43210 owner', '919876543210', '98765.43210', '9 8765 43210',
  'wa.me/919876543210', 'https://wa.me/919876543210?text=hi', 'tel:+919876543210', 'location https://maps.app.goo.gl/AbC123', 'https://www.google.com/maps/place/x',
  'goo.gl/maps/xyz', 'https://maps.google.co.in/?q=1', 'see https://www.facebook.com/groups/1/posts/77/', 'm.facebook.com/story.php?id=1', 'mail owner@example.com',
];
const MOBILE = /(?<!\d)(?:\+?91|0)?[\s.-]{0,2}[6-9](?:[\s.-]{0,2}\d){9}(?!\d)/;
function assertNoLeak(s, label) {
  assert.doesNotMatch(s, MOBILE, label + ': mobile number');
  assert.doesNotMatch(s.replace(/[\s.\-()+]/g, ''), /(?<!\d)(?:91|0)?[6-9]\d{9}(?!\d)/, label + ': mobile with separators stripped');
  for (const bad of [/maps\.app\.goo\.gl/i, /google\.[a-z.]+\/maps/i, /maps\.google/i, /goo\.gl/i, /wa\.me/i, /tel:/i, /facebook\.com/i, /@example\.com/i, /Ravi Kumar/, /Sobha Elite/]) assert.doesNotMatch(s, bad, label + ': ' + bad);
}

test('serializer: public text masks phones as a token and strips links, emails and society', () => {
  for (const t of LEAKY) { const out = publicText(t); assertNoLeak(out, t); }
  assert.equal(publicText('Call 9876543210'), 'Call [[phone]]');
  assert.equal(publicText('Rent 65000, deposit 2,00,000, 2BHK, 1200 sqft'), 'Rent 65000, deposit 2,00,000, 2BHK, 1200 sqft', 'money untouched');
  const l = { id: 'l_1', rent: 30000, bhk: 2, society: 'Sobha Elite Apartments', phones: ['9876543210'], mapLinks: ['https://maps.app.goo.gl/x'], notes: 'secret', stage: 'Visited',
    posts: [{ id: 'p', url: 'https://www.facebook.com/groups/1/posts/2/', urlKey: 'facebook.com/groups/1/posts/2', author: 'Ravi Kumar', group: 'Bellandur Flats', text: LEAKY.join(' | ') + ' at Sobha Elite Apartments', images: ['https://scontent.xx.fbcdn.net/a.jpg', 'https://evil.example/x.jpg'] }] };
  const p = publicListing(l, { maxPosts: 15 });
  assertNoLeak(JSON.stringify(p), 'publicListing');
  assert.equal(p.groups.length, 0); assert.equal(p.posts[0].group, 'Bellandur Flats', 'group name kept');
  assert.deepEqual(p.posts[0].images, ['https://scontent.xx.fbcdn.net/a.jpg']);
  for (const k of ['phones', 'mapLinks', 'notes', 'stage', 'society', 'status']) assert.equal(p[k], undefined, k);
  assert.equal(p.hasPhone, true);
  PHONE_ANY.lastIndex = 0;
});

test('public API: browse by area with filters, detail, no leaks, samples hidden, per-IP rate limit', async () => {
  const h = await harness({ PUBLIC_RATE_LIMIT: '8' });
  const gg = await h.repo.createArea(GREEN_GLEN, Date.now());
  const { ingestItems } = await import('../src/ingest.js');
  const items = LEAKY.map((t, i) => ({ text: `${1 + (i % 3)}BHK available in Green Glen Layout, rent ${20000 + i * 1000}. ${t}. At Sobha Elite Apartments. ${'abcdefghijklmnopq'[i]}xyz${i} unique words ${i}`, url: `https://www.facebook.com/groups/1/posts/${i}/`, author: 'Ravi Kumar', groupName: 'Bellandur Flats', createdAt: new Date(Date.now() - i * 60e3).toISOString() }));
  await ingestItems(h.repo, items, { source: 'apify', storeAll: true });
  await ingestItems(h.repo, [{ text: '3BHK sample in Green Glen Layout rent 50000' }], { source: 'sample', sample: true });
  const ip = { 'cf-connecting-ip': '198.51.100.7' };
  const all = await h.jcall('GET', `/api/public/listings?area=${gg.id}&limit=60`, { headers: ip });
  assert.equal(all.status, 200); assert.ok(all.data.listings.length >= 10); assert.ok(all.data.listings.every(l => l.rent !== 50000), 'samples hidden');
  assertNoLeak(JSON.stringify(all.data), 'list');
  const two = await h.jcall('GET', `/api/public/listings?area=${gg.id}&bhk=2&maxRent=30000`, { headers: ip });
  assert.ok(two.data.listings.length > 0 && two.data.listings.every(l => l.bhk === 2 && l.rent <= 30000));
  const d = await h.jcall('GET', `/api/public/listings/${all.data.listings[0].id}`, { headers: ip });
  assert.equal(d.status, 200); assertNoLeak(JSON.stringify(d.data), 'detail');
  const areas = await h.jcall('GET', '/api/public/areas', { headers: ip });
  assert.equal(areas.data.areas[0].name, 'Green Glen');
  assert.equal((await h.call('GET', '/api/public/listings?bhk=evil', { headers: ip })).status, 400);
  const codes = []; for (let i = 0; i < 6; i++) codes.push((await h.call('GET', '/api/public/areas', { headers: ip })).status);
  assert.ok(codes.includes(429), codes.join(','));
  assert.equal((await h.call('GET', '/api/public/areas', { headers: { 'cf-connecting-ip': '198.51.100.8' } })).status, 200, 'other IPs unaffected');
  assert.equal((await h.call('GET', '/api/listings')).status, 401, 'the full API still needs sign-in');
});

// ---------- admin API ----------
test('admin API: schedule settings, groups with Page warning, runs/stats, areas merge, listings search/delete, phone scans', async () => {
  const h = await harness();
  const { cookie } = await h.sessionFor('boss@example.com', 'admin');
  const user = await h.sessionFor('u@example.com');
  const A = (m, p, body) => h.jcall(m, p, { body, headers: { cookie } });
  assert.equal((await h.call('GET', '/api/admin/stats', { headers: { cookie: user.cookie } })).status, 403);
  const sc = await A('GET', '/api/admin/scraper');
  assert.deepEqual(sc.data.schedule, { enabled: true, intervalHours: 4, budgetWarnPct: 80, budgetStopPct: 95, retentionDays: 30, backfillDays: 3, redditEnabled: true });
  assert.equal((await A('PUT', '/api/admin/scraper', { intervalHours: 6, backfillDays: 2, retentionDays: 60 })).data.schedule.intervalHours, 6);
  assert.equal((await A('PUT', '/api/admin/scraper', { backfillDays: 9 })).status, 400);
  assert.equal((await A('PUT', '/api/admin/scraper', { budgetWarnPct: 90, budgetStopPct: 85 })).status, 400);

  const g = await A('POST', '/api/admin/groups', { name: 'FindMyRoom', url: 'https://www.facebook.com/FindMyRoomBangalore' });
  assert.equal(g.status, 200); assert.equal(g.data.groups[0].kind, 'page'); assert.equal(g.data.groups[0].supported, false); assert.match(g.data.warnings[0].warning, /Page/);
  const g2 = await A('POST', '/api/admin/groups', { name: 'Bellandur', url: 'https://m.facebook.com/groups/123/?ref=x' });
  assert.equal(g2.data.groups[1].url, 'https://www.facebook.com/groups/123'); assert.equal(g2.data.groups[1].supported, true);
  assert.equal((await A('POST', '/api/admin/groups', { url: 'https://www.facebook.com/groups/123' })).status, 409);
  assert.equal((await A('POST', '/api/admin/groups', { url: 'https://evil.example/groups/1' })).status, 400);
  const off = await A('PATCH', `/api/admin/groups/${g2.data.groups[1].id}`, { active: false });
  assert.equal(off.data.groups[1].active, false);
  assert.equal((await A('DELETE', `/api/admin/groups/${g.data.groups[0].id}`)).data.groups.length, 1);

  const gg = await h.repo.createArea(GREEN_GLEN, Date.now());
  const ph = await A('POST', '/api/admin/phone-scan', { source: 'phone-scan', posts: [
    { text: '2BHK in Green Glen Layout rent 28000 call 9000011111', groupName: 'Unwatched Flats', url: 'https://www.facebook.com/groups/9/posts/1/' },
    { text: '1BHK in Koramangala for rent 22000, 9000022222', groupName: 'Unwatched Flats', url: 'https://www.facebook.com/groups/9/posts/2/' },
    { text: 'Selling a study table, DM', groupName: 'Unwatched Flats' }] });
  assert.equal(ph.data.report.newListings, 2, 'off-area housing posts are stored too'); assert.equal(ph.data.report.notHousing, 1);
  const scans = await A('GET', '/api/admin/phone-scans');
  assert.equal(scans.data.scans.length, 1); assert.equal(scans.data.outsideGroups[0].group, 'Unwatched Flats');
  const runs = await A('GET', '/api/admin/runs?limit=5');
  const r = runs.data.runs[0];
  assert.equal(r.source, 'phone'); assert.equal(r.postsFetched, 3); assert.equal(r.matchedArea, 1); assert.equal(r.newListings, 2); assert.equal(r.notHousing, 1); assert.ok(r.durationMs >= 0);
  const st = await A('GET', '/api/admin/stats?days=7');
  assert.equal(st.data.perDay.length, 7); assert.equal(st.data.totals.postsFetched, 3); assert.equal(st.data.sources.phone.newListings, 2);
  assert.equal(st.data.groups[0].group, 'Unwatched Flats'); assert.equal(st.data.groups[0].newListings, 2); assert.equal(st.data.areas[0].listings, 1);
  const src = await A('GET', '/api/admin/sources');
  assert.deepEqual(src.data.sources.map(s => [s.id, s.connected]), [['apify', false], ['reddit', false], ['phone', true]]);

  const kor = (await A('POST', '/api/areas', { name: 'Koramangala' })).data;
  assert.equal(kor.matching, false, 'backfill finished inline');
  assert.equal((await A('GET', `/api/admin/listings?area=${kor.id}`)).data.total, 1, 'stored off-area post backfilled into the new area');
  const merged = await A('POST', `/api/admin/areas/${kor.id}/merge`, { into: gg.id });
  assert.ok(merged.data.keywords.includes('koramangala'));
  assert.equal((await A('GET', `/api/admin/listings?area=${gg.id}`)).data.total, 2);
  assert.equal((await h.repo.listAreas()).length, 1);
  const found = await A('GET', '/api/admin/listings?q=Koramangala');
  assert.equal(found.data.total, 1);
  assert.equal((await A('POST', '/api/admin/listings/delete', { ids: [found.data.listings[0].id] })).data.deleted, 1);
  assert.equal((await h.call('GET', '/api/admin/listings/export', { headers: { cookie } })).status, 200);
});

test('migration 0002 keeps existing areas, settings and listings', async () => {
  const raw = await openSqlite(':memory:');
  const all = loadMigrations();
  migrateSqlite(raw, all.filter(m => m.name.startsWith('0001')));
  raw.prepare('INSERT INTO areas (name, keywords, active, created_at) VALUES (?, ?, 1, 1)').run('Green Glen', '["green glen"]');
  raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('groups', JSON.stringify([{ name: 'A', url: 'https://www.facebook.com/groups/1', active: true }]));
  raw.prepare(`INSERT INTO listings (id, status, stage, notes, last_posted_at, created_at, updated_at) VALUES ('l1', 'approved', 'To call', 'n', 1, 1, 1)`).run();
  assert.deepEqual(migrateSqlite(raw, all), all.filter(m => !m.name.startsWith('0001')).map(m => m.name));
  const repo = createRepo(sqliteDriver(raw));
  assert.equal((await repo.listAreas())[0].name, 'Green Glen');
  assert.equal((await repo.getSettings()).groups.length, 1);
  const l = await repo.getListing('l1');
  assert.equal(l.status, 'approved'); assert.equal(l.aiStatus, '');
  for (const m of all) { const sql = m.sql.replace(/--[^\n]*/g, ''); assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/i, m.name); assert.doesNotMatch(sql, /fts5|VIRTUAL TABLE/i, m.name); assert.doesNotMatch(sql, /\bDROP\b|RENAME/i, m.name + ' is add-only'); }
});

// QA round 2: production upgrade path. The founder logs in with the password before ADMIN_EMAILS is
// set (placeholder account takes the legacy state), then sets ADMIN_EMAILS: his real account must
// get the areas and decisions, not an empty deck.
test('legacy state taken by the break-glass placeholder moves to the first real admin (QA)', async () => {
  const PW = 'correct horse battery staple';
  const first = await harness({ APP_PASSWORD: PW, ADMIN_EMAILS: '', GOOGLE_CLIENT_ID: '' });
  const area = await first.repo.createArea(GREEN_GLEN, Date.now());
  const { ingestItems } = await import('../src/ingest.js');
  await ingestItems(first.repo, [{ text: '2BHK available in Green Glen Layout, rent 30000', url: 'https://www.facebook.com/groups/1/posts/9/' }], { source: 'manual' });
  const [l] = await first.repo.listListings();
  await first.repo.updateListingFields(l.id, { status: 'approved', stage: 'Visited', notes: 'nice', decidedAt: 1, hasUpdate: false }, Date.now());
  const c1 = cookies(await first.call('POST', '/api/login', { body: { password: PW } }))[0];
  assert.equal((await first.jcall('GET', '/api/me', { headers: { cookie: c1 } })).data.user.email, 'break-glass@flat-hunt.invalid');
  // Same database, ADMIN_EMAILS now set.
  const app = createApp({ repo: () => first.repo, assets: async () => null });
  const env = { ...ENV, APP_PASSWORD: PW, ADMIN_EMAILS: 'founder@example.com', GOOGLE_CLIENT_ID: '' };
  const call = (m, p, body, headers = {}) => app.fetch(new Request(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) }), env, {});
  const c2 = cookies(await call('POST', '/api/login', { password: PW }))[0];
  const me = await (await call('GET', '/api/me', undefined, { cookie: c2 })).json();
  assert.equal(me.user.email, 'founder@example.com');
  assert.deepEqual((await (await call('GET', '/api/areas', undefined, { cookie: c2 })).json()).areas.map(a => a.id), [area.id]);
  const mine = (await (await call('GET', '/api/listings?status=approved', undefined, { cookie: c2 })).json()).listings;
  assert.equal(mine.length, 1); assert.equal(mine[0].notes, 'nice');
});
