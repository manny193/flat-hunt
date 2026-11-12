// Where is the flat: only the post's own text tags an area; the AI reads the area and what is merely nearby;
// societies and map links the text cannot place are looked up (OpenStreetMap, Google Maps redirect), cached,
// rate-limited and retried. All network mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingAreas, retagAreas, makeContext, reparseListing } from '../src/core/logic.js';
import { validateResult, mergeAi, runEnrich, redact, SCHEMA, FEW_SHOT } from '../src/ai.js';
import { parseMapUrl, resolveMapLink, findSociety, addressText, coreTokens, needsLookup, runLocate, NOMINATIM, LOC_MAX_ATTEMPTS, LOC_QUERIES, MAX_FETCHES } from '../src/locate.js';
import { ingestItems } from '../src/ingest.js';
import { startBackfill } from '../src/backfill.js';
import { budgeted } from '../src/apify.js';
import { serializeListing } from '../src/serialize.js';
import { memoryDb } from './helpers.js';

const AREAS = [{ id: 1, name: 'Bellandur', keywords: ['bellandur'], active: true }, { id: 2, name: 'HSR Layout', keywords: ['hsr layout', 'hsr'], active: true },
  { id: 3, name: 'Koramangala', keywords: ['koramangala'], active: true }, { id: 4, name: 'Varthur', keywords: ['varthur'], active: true }];
const ctx = makeContext(AREAS, {});
const result = (id, o = {}) => ({ id, isRental: true, kind: 'offer', type: 'flat', bhk: null, rent: null, deposit: null, depositMonths: null, maintenance: null, brokerage: null, brokerageAmount: null, furnishing: null, gender: null, availableFrom: null, society: null, locality: null, area: null, societyArea: null, nearby: [], otherUnits: [], summary: 's', confidence: 0.9, ...o });
const NOM = { name: 'Sobha Dream Acres', display_name: 'Sobha Dream Acres, Panathur Road, Balagere, Varthur, Bengaluru, Karnataka, 560087, India', lat: '12.9352', lon: '77.7260',
  address: { residential: 'Sobha Dream Acres', road: 'Panathur Road', neighbourhood: 'Balagere', suburb: 'Varthur', city: 'Bengaluru', state: 'Karnataka', postcode: '560087', country: 'India' } };
const redirect = to => new Response(null, { status: 302, headers: { location: to } });
const noSleep = async () => {};

test('areas of a listing: text first, minus what the AI read as only nearby; then AI area, lookup, AI guess', () => {
  const post = text => ({ posts: [{ text, group: 'Flats in Koramangala' }] });
  assert.deepEqual(listingAreas(post('2BHK for rent, 30k'), ctx.areas), [], 'the group name never tags a post');
  const both = post('2BHK in Bellandur, 10 min from HSR Layout');
  assert.deepEqual(listingAreas(both, ctx.areas), [1, 2], 'rules alone: every area named');
  assert.deepEqual(listingAreas({ ...both, place: { area: 'Bellandur', nearby: ['10 min from HSR Layout'] } }, ctx.areas), [1], 'HSR is only nearby');
  assert.deepEqual(listingAreas({ ...post('Flat 10 min from HSR Layout'), place: { nearby: ['HSR Layout'] } }, ctx.areas), [2], 'the only place named is never removed');
  assert.deepEqual(listingAreas({ ...both, locality: 'HSR Layout', place: { nearby: ['HSR Layout'] } }, ctx.areas), [1, 2], 'a place the AI also read as the locality stays');
  assert.deepEqual(listingAreas({ ...post('1bhk in kormangla 4th blk'), place: { area: 'Koramangala' } }, ctx.areas), [3], 'the AI spells the area normally');
  assert.deepEqual(listingAreas({ ...post('Flat in Sobha Dream Acres'), place: { guess: 'Bellandur', text: 'Sobha Dream Acres, Panathur Road, Balagere, Varthur' } }, ctx.areas), [4], 'a looked-up address beats the AI guess');
  assert.deepEqual(listingAreas({ ...post('Flat in Sobha Dream Acres'), place: { guess: 'Varthur' } }, ctx.areas), [4], 'the guess is used until a lookup answers');
  const l = { areas: [3, 9], posts: [{ text: 'room in Bellandur', group: 'Koramangala flats' }] };
  assert.equal(retagAreas(l, ctx), true); assert.deepEqual(l.areas, [1, 9], 'paused area 9 kept, the group tag 3 gone');
  const stored = { areas: [], place: { text: 'Balagere, Varthur' }, posts: [{ text: '2BHK in Sobha Dream Acres 40k' }] };
  reparseListing(stored, ctx); assert.deepEqual(stored.areas, [4], 're-check keeps what a lookup found');
});

test('AI place fields: schema and few-shot carry them; validation grounds nearby; low confidence is not used', () => {
  const props = SCHEMA.properties.results.items;
  for (const k of ['area', 'societyArea', 'nearby']) { assert.ok(props.properties[k] && props.required.includes(k)); assert.ok(FEW_SHOT[1].content.includes(`"${k}"`)); }
  const text = 'Flat in Sobha Dream Acres, 15 mins to Manyata. Call [PHONE]';
  const v = validateResult(result('P1', { society: 'Sobha Dream Acres', societyArea: 'Varthur', nearby: ['Manyata', 'Hebbal', 7], area: '[PHONE]' }), text);
  assert.equal(v.fields.area, null); assert.equal(v.fields.societyArea, 'Varthur'); assert.deepEqual(v.fields.nearby, ['Manyata'], 'only places written in the post');
  assert.equal(validateResult(result('P1', { societyArea: 'Varthur' }), text).fields.societyArea, null, 'no society, no guess');
  assert.equal(validateResult(result('P1', { society: 'Sobha Dream Acres', area: 'Varthur', societyArea: 'Bellandur' }), text).fields.societyArea, null, 'a stated area needs no guess');
  const l = { id: 'a', kind: 'offer' };
  mergeAi(l, v, { now: 1 }); assert.deepEqual(l.place, { guess: 'Varthur', nearby: ['Manyata'] });
  const low = { id: 'b', kind: 'offer' };
  mergeAi(low, validateResult(result('P1', { area: 'Bellandur', confidence: 0.4 }), text), { now: 1 }); assert.equal(low.place, undefined);
  const found = { id: 'c', kind: 'offer', place: { text: 'Balagere, Varthur', src: 'society', area: 'Old' } };
  mergeAi(found, validateResult(result('P1', { area: 'Varthur' }), text), { now: 1 }); assert.deepEqual(found.place, { text: 'Balagere, Varthur', src: 'society', area: 'Varthur' }, 'a lookup result is kept');
});

test('map links: place name and coordinates from every common Google Maps URL shape', () => {
  assert.deepEqual(parseMapUrl('https://www.google.com/maps/place/Sobha+Dream+Acres/@12.93,77.72,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d12.9352!4d77.7260'), { name: 'Sobha Dream Acres', lat: 12.9352, lon: 77.726 });
  assert.deepEqual(parseMapUrl('https://maps.google.com/?q=12.9116,77.6389'), { name: null, lat: 12.9116, lon: 77.6389 });
  assert.deepEqual(parseMapUrl('https://www.google.com/maps/search/?api=1&query=HSR%20Layout%20Sector%202'), { name: 'HSR Layout Sector 2', lat: null, lon: null });
  assert.deepEqual(parseMapUrl('https://www.google.co.in/maps/@12.97,77.59,15z'), { name: null, lat: 12.97, lon: 77.59 });
  assert.equal(parseMapUrl('https://evil.example/maps/place/X/@1.5,2.5'), null); assert.equal(parseMapUrl('not a url'), null);
});

test('short map links are followed across Google hosts only, by hand', async () => {
  const seen = [];
  const hops = { 'https://maps.app.goo.gl/abc': 'https://consent.google.com/m?continue=' + encodeURIComponent('https://www.google.com/maps/place/Koramangala+4th+Block/@12.93,77.62,17z') };
  const fetchFn = async (u, init) => { seen.push(u); assert.equal(init.redirect, 'manual'); return hops[u] ? redirect(hops[u]) : new Response('', { status: 200 }); };
  assert.deepEqual(await resolveMapLink('https://maps.app.goo.gl/abc', fetchFn), { name: 'Koramangala 4th Block', lat: 12.93, lon: 77.62 });
  assert.deepEqual(seen, ['https://maps.app.goo.gl/abc'], 'the full URL is parsed, not fetched');
  assert.equal(await resolveMapLink('https://maps.app.goo.gl/x', async () => redirect('https://evil.example/maps/place/X/@12.9,77.6')), null, 'a redirect off Google is dropped');
  assert.equal(await resolveMapLink('https://goo.gl/maps/y', async () => new Response('', { status: 404 })), null);
  await assert.rejects(resolveMapLink('https://maps.app.goo.gl/z', async () => new Response('', { status: 503 })), /503/, 'an outage is retried later');
});

test('society search: inside the city, the result must carry the society name; address parts only', async () => {
  const urls = [];
  const fetchFn = async (u, init) => { urls.push(new URL(u)); assert.match(init.headers['user-agent'], /^FlatHunt/); return Response.json([{ ...NOM, name: 'Dream Bakery', display_name: 'Dream Bakery, HSR Layout' }, { ...NOM, lat: '19.07', lon: '72.87' }, NOM]); };
  const opt = { fetchFn, env: {}, geo: { used: 0, sleep: noSleep } };
  const r = await findSociety('Sobha Dream Acres Apartments', opt);
  assert.deepEqual(r, { text: 'Sobha Dream Acres, Panathur Road, Balagere, Varthur', lat: 12.9352, lon: 77.726 });
  assert.equal(urls[0].origin, NOMINATIM); assert.equal(urls[0].searchParams.get('bounded'), '1'); assert.equal(urls[0].searchParams.get('q'), 'Sobha Dream Acres Apartments, Bengaluru');
  assert.doesNotMatch(addressText(NOM), /Bengaluru|Karnataka|560087|India/);
  assert.deepEqual(coreTokens('The Sai Nest Apartments'), ['sai']);
  assert.equal(await findSociety('Sai Nest Apartments', opt), null, 'too generic to search'); assert.equal(urls.length, 1);
});

async function world() {
  const t = await memoryDb(); const now = Date.now();
  for (const a of AREAS) await t.repo.createArea(a, now);
  const u = await t.repo.upsertUser({ email: 'u@example.com' }, now);
  const posts = [
    { text: '2BHK available in Sobha Dream Acres Apartments, rent 42k, deposit 1.5L, call 9000011111', url: 'https://www.facebook.com/groups/1/posts/1/', groupName: 'Flats in Koramangala' },
    { text: '1BHK for rent 18k, location https://maps.app.goo.gl/abc call 9000022222', url: 'https://www.facebook.com/groups/1/posts/2/', groupName: 'Flats in Koramangala' },
    { text: '3BHK in Bellandur, 5 mins drive to HSR Layout, rent 55k, call 9000033333', url: 'https://www.facebook.com/groups/1/posts/3/', groupName: 'Flats in Koramangala' },
  ];
  await ingestItems(t.repo, posts.map(p => ({ ...p, createdAt: now - 36e5 })), { source: 'apify', storeAll: true });
  const AI = { run: async (model, input) => ({ response: { results: [...input.messages.at(-1).content.matchAll(/<post id="(P\d+)"[^>]*>([^<]*)/g)].map(([, id, text]) => result(id,
    /Sobha/.test(text) ? { society: 'Sobha Dream Acres Apartments', societyArea: 'Bellandur' } : /Bellandur/.test(text) ? { locality: 'Bellandur', area: 'Bellandur', nearby: ['HSR Layout'] } : {})) } }) };
  const byText = async re => (await t.repo.listListings()).find(l => re.test(l.posts[0].text));
  return { ...t, now, u, AI, byText };
}

test('end to end: a post is never filed under its group; the AI narrows; society and map link are looked up, cached, alerted', async () => {
  const t = await world();
  assert.deepEqual((await t.repo.listListings()).map(l => l.areas).sort(), [[], [], [1, 2]], 'no post is in Koramangala (the group); rules tag both named areas');
  // alerts on Varthur, to see a listing placed later still alert
  await t.repo.linkArea(t.u.id, 4, t.now); await t.repo.putSettings({ alerts: { enabled: true } });
  await t.repo.db.run('INSERT INTO alert_prefs (user_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)', [t.u.id, t.now, t.now]);
  await t.repo.db.run('INSERT OR IGNORE INTO alert_areas (user_id, area_id, bhks, created_at) VALUES (?, 4, \'\', ?)', [t.u.id, t.now]);

  const r = await runEnrich(t.repo, { AI: t.AI }, { now: t.now });
  assert.equal(r.done, 3);
  assert.deepEqual((await t.byText(/Bellandur/)).areas, [1], 'HSR Layout was only nearby');
  const soc = await t.byText(/Sobha/);
  assert.deepEqual(soc.areas, [1], 'until the lookup answers, the AI guess (Bellandur) is used');
  assert.deepEqual(await t.repo.locStats(), { pending: 2 }, 'the society post and the map-link post wait for a lookup');

  const calls = [];
  const fetchFn = async (u) => {
    calls.push(u); const url = new URL(u);
    if (url.hostname === 'maps.app.goo.gl') return redirect('https://www.google.com/maps/place/My+Home/@12.9116,77.6389,17z');
    if (url.pathname === '/reverse') return Response.json({ name: '', address: { road: '17th Cross', neighbourhood: 'Sector 2', suburb: 'HSR Layout', city: 'Bengaluru' } });
    if (url.pathname === '/search') return Response.json([NOM]);
    throw new Error('unexpected ' + u);
  };
  const sleeps = [];
  const repo = budgeted(t.repo);
  const res = await runLocate(repo, { PUBLIC_BASE_URL: 'https://flats.example' }, { now: t.now, fetchFn, sleep: async ms => { sleeps.push(ms); } });
  assert.ok(repo.used() <= LOC_QUERIES, `lookup step used ${repo.used()} D1 statements`);
  assert.deepEqual({ found: res.found, tagged: res.tagged, lookups: res.lookups }, { found: 2, tagged: 2, lookups: 2 });
  assert.deepEqual(sleeps, [1100], 'one second between geocoder requests');
  assert.ok(calls.every(u => !/9000\d{6}|rent|deposit/.test(decodeURIComponent(u))), 'no phone or post text leaves, only the society name or coordinates');
  const soc2 = await t.byText(/Sobha/);
  assert.deepEqual(soc2.areas, [4], 'the looked-up address (Varthur) replaces the AI guess');
  assert.equal(soc2.place.src, 'society'); assert.match(soc2.place.text, /Balagere, Varthur/);
  const map = await t.byText(/location/);
  assert.deepEqual(map.areas, [2]); assert.equal(map.place.src, 'map'); assert.match(map.place.text, /My Home, 17th Cross, Sector 2, HSR Layout/);
  assert.deepEqual(await t.repo.locStats(), { done: 2 });
  assert.deepEqual((await t.repo.db.all('SELECT listing_id, area_id FROM alert_queue')), [{ listing_id: soc2.id, area_id: 4 }], 'placed after ingest: the Varthur follower is still alerted');
  assert.equal((await runLocate(t.repo, {}, { now: t.now, fetchFn })).action, 'idle');
  // the public never sees the place
  assert.equal(serializeListing(soc2, 'public').place, undefined); assert.doesNotMatch(JSON.stringify(serializeListing(soc2, 'public')), /Balagere|Panathur/);
  // the same society again: answered from the cache, no request
  await ingestItems(t.repo, [{ text: 'Single room in Sobha Dream Acres Apartments 3BHK, 16k per head, call 9000044444', url: 'https://www.facebook.com/groups/1/posts/4/', createdAt: t.now - 36e5 }], { source: 'apify', storeAll: true });
  await runEnrich(t.repo, { AI: t.AI }, { now: t.now + 1 });
  const before = calls.length;
  const again = await runLocate(t.repo, {}, { now: t.now + 2, fetchFn });
  assert.equal(again.found, 1); assert.equal(calls.length, before, 'cache hit');
  assert.deepEqual((await t.byText(/Single room/)).areas, [4]);
  // an area added later finds the looked-up address too
  const bal = await t.repo.createArea({ name: 'Balagere', keywords: ['balagere'], active: true }, t.now);
  await startBackfill(t.repo, bal, t.now);
  assert.equal((await t.repo.listListings({ area: bal.id })).length, 2, 'backfill reads the place, not only the post text');
});

test('lookup failures: outage retries with backoff then fails; nothing found is final; the request cap defers the rest', async () => {
  const t = await world();
  await runEnrich(t.repo, { AI: t.AI }, { now: t.now });
  let now = t.now;
  const down = async () => new Response('', { status: 503 });
  const r1 = await runLocate(t.repo, {}, { now, fetchFn: down, sleep: noSleep });
  assert.match(r1.error, /503/); assert.deepEqual(await t.repo.locStats(), { retry: 2 });
  assert.equal((await runLocate(t.repo, {}, { now: now + 60e3, fetchFn: down, sleep: noSleep })).action, 'idle', 'backoff');
  for (let i = 0; i < LOC_MAX_ATTEMPTS; i++) { now += 48 * 36e5; await runLocate(t.repo, {}, { now, fetchFn: down, sleep: noSleep }); }
  assert.deepEqual(await t.repo.locStats(), { failed: 2 });
  assert.deepEqual((await t.byText(/Sobha/)).areas, [1], 'the listing keeps what it had');

  const t2 = await world();
  await runEnrich(t2.repo, { AI: t2.AI }, { now: t2.now });
  const capped = await runLocate(t2.repo, {}, { now: t2.now, maxGeo: 0, fetchFn: async u => new URL(u).hostname === 'maps.app.goo.gl' ? redirect('https://www.google.com/maps/@12.9116,77.6389,17z') : Response.json([]), sleep: noSleep });
  assert.equal(capped.waiting, 2); assert.deepEqual(await t2.repo.locStats(), { pending: 2 }, 'over the request cap: still queued');
  const none = await runLocate(t2.repo, {}, { now: t2.now, fetchFn: async u => new URL(u).hostname === 'maps.app.goo.gl' ? new Response('', { status: 404 }) : Response.json([]), sleep: noSleep });
  assert.equal(none.found, 0); assert.deepEqual(await t2.repo.locStats(), { none: 2 });
  assert.equal(needsLookup({ society: 'X Residency', posts: [{ text: 'flat in Bellandur' }] }, ctx), false, 'a post that names an area needs no lookup');
});

test('QA F1-F5: only Google hosts, no map link reaches the model, a brand name is not a society, requests per run are capped', async () => {
  // F1: look-alike hosts are neither parsed nor fetched; a full Maps URL is never fetched at all
  let hits = 0; const spy = async () => { hits++; return new Response('', { status: 200 }); };
  for (const u of ['https://google.evil.com/x', 'https://google.attack.io/maps/place/X/@12.9,77.6', 'https://google.com.evil.com/maps?q=12.9,77.6', 'https://www.google.com/maps/unknown-shape']) {
    assert.equal(await resolveMapLink(u, spy), null, u);
  }
  assert.equal(hits, 0); assert.equal(parseMapUrl('https://google.evil.com/maps/place/X/@12.9,77.6'), null);
  for (const u of ['https://www.google.co.in/maps/@12.97,77.59,15z', 'https://maps.google.com/?q=12.9,77.6', 'https://google.com.au/maps/@12.97,77.59,15z']) assert.ok(parseMapUrl(u), u);
  // F2: scheme-less map links and their coordinates are redacted
  for (const t of ['see google.com/maps/place/Sobha+Dream/@12.93,77.72,17z', 'maps.google.com/?q=12.9116,77.6389', 'g.co/kgs/abc', 'www.google.co.in/maps?q=12.9116,77.6389', 'pin @12.9352,77.7260 here']) {
    assert.doesNotMatch(redact(t), /google|g\.co|12\.9|77\.[67]/, t); assert.match(redact(t), /\[LINK\]/);
  }
  // F3: a one-word brand does not match a longer-named place
  const opt = () => ({ fetchFn: async () => Response.json([{ ...NOM, name: 'Prestige Falcon City', display_name: 'Prestige Falcon City, Kanakapura Road' }]), env: {}, geo: { used: 0, sleep: noSleep } });
  assert.equal(await findSociety('Prestige Apartments', opt()), null);
  assert.equal(await findSociety('Brigade Residency', { ...opt(), fetchFn: async () => Response.json([{ ...NOM, name: 'Brigade Gateway', display_name: 'Brigade Gateway, Malleswaram' }]) }), null);
  assert.ok(await findSociety('Prestige Falcon City Apartments', opt()), 'the same place under its full name still matches');
  // F5: endless redirects cannot push one run past the request cap
  const t = await memoryDb(); const now = Date.now();
  await t.repo.createArea(AREAS[0], now);
  await ingestItems(t.repo, Array.from({ length: 6 }, (_, i) => ({ text: `${['1BHK', '2BHK', '3BHK', '4BHK', '1RK', 'PG room'][i]} for rent ${15 + i * 9}k, ${['fully furnished', 'semi furnished', 'unfurnished', 'with parking', 'top floor', 'food included'][i]}, location https://maps.app.goo.gl/a${i} and https://maps.app.goo.gl/b${i} call 90000${10000 + i * 7919}`, url: `https://www.facebook.com/groups/1/posts/${i + 1}/`, createdAt: now - 36e5 })), { source: 'apify', storeAll: true });
  const ids = (await t.repo.listListings()).map(l => l.id); assert.ok(ids.length >= 4);
  await t.repo.db.batch([t.repo.locEnqueueStatement(ids, now)]);
  let n = 0;
  const r = await runLocate(t.repo, {}, { now, sleep: noSleep, fetchFn: async () => redirect('https://maps.app.goo.gl/loop' + (++n)) });
  assert.ok(n <= MAX_FETCHES + 8, `one run made ${n} requests`); assert.ok(r.waiting > 0, 'the rest wait for the next run');
});

test('senior review: a blocked geocoder (403) is an error, not "not found": nothing is cached and the listing is retried', async () => {
  const t = await world();
  await runEnrich(t.repo, { AI: t.AI }, { now: t.now });
  const blocked = async u => new URL(u).hostname === 'maps.app.goo.gl' ? redirect('https://www.google.com/maps/@12.9116,77.6389,17z') : new Response('Access blocked', { status: 403 });
  const r = await runLocate(t.repo, {}, { now: t.now, fetchFn: blocked, sleep: noSleep });
  assert.match(r.error, /403/); assert.equal(r.found, 0);
  assert.deepEqual(await t.repo.locStats(), { retry: 2 });
  assert.equal((await t.repo.db.all('SELECT * FROM places')).length, 0, 'no society cached as not found');
  // deleting a listing also removes its lookup row
  const soc = await t.byText(/Sobha/);
  await t.repo.deleteListings([soc.id]);
  assert.deepEqual(await t.repo.locStats(), { retry: 1 });
});
