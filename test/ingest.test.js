// SQL-backed ingest: parity with the reference pipeline, dedupe rules, Apify shapes, timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ingestItems } from '../src/ingest.js';
import { processItems, makeContext, prepareItems, normalizeRaw } from '../src/core/logic.js';
import { memoryDb, SAMPLES, GREEN_GLEN } from './helpers.js';

const NOW = Date.UTC(2026, 10, 7, 6);
async function setup(areas = [GREEN_GLEN]) {
  const t = await memoryDb();
  for (const a of areas) await t.repo.createArea(a, NOW);
  return t;
}
const url = i => `https://www.facebook.com/groups/1/posts/${i}/`;

test('ingest of the samples matches the in-memory reference pipeline', async () => {
  const { repo } = await setup();
  const { report } = await ingestItems(repo, SAMPLES, { source: 'phone', now: NOW });
  const ref = processItems(SAMPLES, 'phone', [], makeContext(await repo.listAreas(), {}), NOW).report;
  for (const k of ['total', 'noText', 'offTopic', 'seeking', 'dupes', 'newListings', 'merged']) assert.equal(report[k], ref[k], k);
  const all = await repo.listListings();
  assert.equal(all.length, 5);
  const top = all.find(l => l.rent === 32000);
  assert.equal(top.seenCount, 2); assert.equal(top.groups.length, 2); assert.deepEqual(top.areas, [1]);
  assert.equal((await repo.listRuns()).length, 1);
});

test('re-importing the same dataset is a no-op (with and without post urls)', async () => {
  const { repo } = await setup();
  const withUrl = SAMPLES.map((s, i) => ({ ...s, url: url(i) }));
  await ingestItems(repo, withUrl, { source: 'scraper', now: NOW });
  const before = await repo.listListings();
  const r = (await ingestItems(repo, withUrl, { source: 'scraper', now: NOW + 1000 })).report;
  assert.deepEqual([r.dupes, r.newListings, r.merged], [6, 0, 0]);
  const after = await repo.listListings();
  assert.deepEqual(after.map(l => [l.id, l.seenCount]), before.map(l => [l.id, l.seenCount]));

  const t2 = await setup();
  await ingestItems(t2.repo, SAMPLES, { source: 'phone', now: NOW });
  const r2 = (await ingestItems(t2.repo, SAMPLES, { source: 'phone', now: NOW + 1000 })).report;
  assert.deepEqual([r2.dupes, r2.newListings, r2.merged], [6, 0, 0]);
});

test('reposts merge: same text in another group, and a reworded repost days later', async () => {
  const { repo } = await setup();
  const base = '2BHK semi-furnished flat available in Green Glen Layout, Bellandur. Rent 32,000 + 2,500 maintenance. Deposit 2 lakh. No brokerage, direct owner. Call 9000011111';
  await ingestItems(repo, [{ text: base, url: url(1), groupTitle: 'Group A', time: NOW - 3 * 864e5 }], { source: 'scraper', now: NOW - 3 * 864e5 });
  const r1 = (await ingestItems(repo, [{ text: base, url: url(2), groupTitle: 'Group B', time: NOW - 864e5 }], { source: 'scraper', now: NOW - 864e5 })).report;
  assert.equal(r1.merged, 1, 'same text, new url -> repost');
  const reworded = 'Semi furnished 2BHK flat available in Green Glen layout Bellandur!! Rent 33000 + 2500 maintenance, deposit 2 lakh. No brokerage – direct owner. Call 9000011111';
  const r2 = (await ingestItems(repo, [{ text: reworded, url: url(3), groupTitle: 'Group C', time: NOW }], { source: 'scraper', now: NOW })).report;
  assert.equal(r2.merged, 1);
  const [l] = await repo.listListings();
  assert.equal(l.seenCount, 3); assert.equal(l.rent, 33000); assert.deepEqual(l.rentHistory.map(h => h.rent), [32000]);
  assert.deepEqual(l.groups.sort(), ['Group A', 'Group B', 'Group C']);
});

test('different flats from the same broker phone stay separate', async () => {
  const { repo } = await setup();
  const items = [
    { text: '3 BHK fully furnished in Green Glen Layout, rent ₹48,000, deposit 3 lakh, brokerage 1 month rent. Contact 9000033333', url: url(1) },
    { text: '2 BHK unfurnished, Green Glen Layout 2nd cross, rent 30k, deposit 1.5 lakh, brokerage applicable. 9000033333', url: url(2) },
    { text: 'Spacious 2BHK east facing with balcony near Green Glen park, lift and power backup, rent 33000. Broker 9000033333', url: url(3) },
  ];
  const r = (await ingestItems(repo, items, { source: 'scraper', now: NOW })).report;
  assert.equal(r.newListings, 3); assert.equal(r.merged, 0);
  // Same phone, same BHK and the same rent on a later post: treated as the same flat.
  const r2 = (await ingestItems(repo, [{ text: 'Green Glen 2BHK, no lift, rent 30000, deposit 1.5L. Call broker 9000033333', url: url(4) }], { source: 'scraper', now: NOW + 1 })).report;
  assert.equal(r2.merged, 1);
});

test('fuzzy matching stays inside an area and a kind', async () => {
  const { repo } = await setup([GREEN_GLEN, { name: 'HSR', keywords: ['hsr layout'], active: true }]);
  await ingestItems(repo, [{ text: '2BHK available in Green Glen, rent 30000, semi furnished, owner 9000077777', url: url(1) }], { source: 'scraper', now: NOW });
  const r = (await ingestItems(repo, [
    { text: '2BHK available in HSR layout, rent 30000, semi furnished, owner 9000077777', url: url(2) },
    { text: 'Looking for 2BHK flat in Green Glen, budget 30000, semi furnished, call 9000077777', url: url(3) },
  ], { source: 'scraper', now: NOW + 1 })).report;
  assert.equal(r.newListings, 2); assert.equal(r.merged, 0);
});

test('repost of a shortlisted listing keeps the decision and flags an update', async () => {
  const { repo } = await setup();
  await ingestItems(repo, [{ text: SAMPLES[0].text, url: url(1) }], { source: 'scraper', now: NOW });
  const [l] = await repo.listListings();
  await repo.updateListingFields(l.id, { status: 'approved', stage: 'Visit booked', notes: 'call at 6', decidedAt: NOW, hasUpdate: false }, NOW);
  await ingestItems(repo, [{ text: SAMPLES[1].text, url: url(2) }], { source: 'scraper', now: NOW + 5000 });
  const after = await repo.getListing(l.id);
  assert.equal(after.status, 'approved'); assert.equal(after.stage, 'Visit booked'); assert.equal(after.notes, 'call at 6');
  assert.equal(after.hasUpdate, true); assert.equal(after.seenCount, 2);
});

test('deleting a listing lets its reposts come back to Review', async () => {
  const { repo } = await setup();
  await ingestItems(repo, [{ text: SAMPLES[0].text, url: url(1) }], { source: 'scraper', now: NOW });
  const [l] = await repo.listListings();
  await repo.deleteListings([l.id]);
  const r = (await ingestItems(repo, [{ text: SAMPLES[0].text, url: url(1) }], { source: 'scraper', now: NOW + 1 })).report;
  assert.equal(r.newListings, 1);
});

// ---------- Apify output shapes ----------
const AUTOMLY_ROWS = [
  { type: 'group', id: '111', name: 'Bellandur Flats & Flatmates', url: 'https://www.facebook.com/groups/111', privacy: 'public' },
  { type: 'group', id: '222', name: 'Secret Flats', url: 'https://www.facebook.com/groups/222', privacy: 'private' },
  { type: 'post', id: 'p1', groupId: '111', text: '2BHK available in Green Glen Layout, rent 31k, no brokerage. 9000012345', url: 'https://www.facebook.com/groups/111/posts/900/', createdAt: '2026-11-07T03:00:00.000Z', authorName: 'Ravi', source: 'https://www.facebook.com/groups/111', media: [{ type: 'photo', imageUrl: 'https://scontent.fblr1-1.fna.fbcdn.net/v/t39/abc.jpg' }] },
  { type: 'post', id: 'p2', groupId: '111', text: 'Selling a sofa, DM', url: 'https://www.facebook.com/groups/111/posts/901/', createdAt: '2026-11-07T02:00:00.000Z' },
  { type: 'report', failedGroups: [{ url: 'https://www.facebook.com/groups/333', reason: 'Group is private' }], postsScraped: 2 },
];
const OFFICIAL_ROWS = [
  { facebookUrl: 'https://www.facebook.com/groups/444', url: 'https://www.facebook.com/groups/444/permalink/77/', time: '2026-11-07T04:00:00+00:00', user: { name: 'Meera', id: 'u1' }, text: 'Flatmate needed in GreenGlen, private room, rent 15000. 9000054321', groupTitle: 'Flats in Bangalore', attachments: [{ thumbnail: 'https://scontent.xx.fbcdn.net/v/t1/room.jpg', __typename: 'Photo' }], likesCount: 3 },
];

test('Apify primary actor rows: group names resolved, non-post rows skipped, unscrapable groups reported', async () => {
  const prep = prepareItems(AUTOMLY_ROWS);
  assert.equal(prep.items.length, 2);
  const p = normalizeRaw(prep.items[0], 'scraper');
  assert.equal(p.group, 'Bellandur Flats & Flatmates'); assert.equal(p.groupUrl, 'https://www.facebook.com/groups/111');
  assert.equal(p.author, 'Ravi'); assert.equal(p.postedAt, Date.parse('2026-11-07T03:00:00Z'));
  assert.deepEqual(p.images, ['https://scontent.fblr1-1.fna.fbcdn.net/v/t39/abc.jpg']);
  assert.deepEqual(prep.unscrapable.map(u => u.url), ['https://www.facebook.com/groups/222', 'https://www.facebook.com/groups/333']);

  const { repo } = await setup();
  const { report } = await ingestItems(repo, AUTOMLY_ROWS, { source: 'scraper', now: NOW, datasetId: undefined });
  assert.equal(report.total, 2); assert.equal(report.offTopic, 1); assert.equal(report.newListings, 1);
  assert.equal(report.unscrapable.length, 2);
  const [l] = await repo.listListings();
  assert.equal(l.posts[0].group, 'Bellandur Flats & Flatmates'); assert.equal(l.rent, 31000);
});

test('Apify official actor rows', async () => {
  const p = normalizeRaw(prepareItems(OFFICIAL_ROWS).items[0], 'scraper');
  assert.equal(p.group, 'Flats in Bangalore'); assert.equal(p.author, 'Meera'); assert.equal(p.groupUrl, 'https://www.facebook.com/groups/444');
  assert.equal(p.urlKey, 'facebook.com/groups/444/permalink/77'); assert.deepEqual(p.images, ['https://scontent.xx.fbcdn.net/v/t1/room.jpg']);
  const { repo } = await setup();
  const { report } = await ingestItems(repo, OFFICIAL_ROWS, { source: 'scraper', now: NOW });
  assert.equal(report.newListings, 1);
  assert.equal((await repo.listListings())[0].type, 'flatmate');
});

const FIXTURE = new URL('./fixtures/apify-sample.json', import.meta.url);
test('real Apify sample (test/fixtures/apify-sample.json) ingests cleanly', { skip: !existsSync(FIXTURE) && 'fixture not provided yet' }, async () => {
  const rows = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const { repo } = await setup();
  const items = Array.isArray(rows) ? rows : rows.items || rows.posts || [];
  const prep = prepareItems(items);
  assert.ok(prep.items.length > 0, 'has post rows');
  const withText = prep.items.map(r => normalizeRaw(r, 'scraper')).filter(p => p.text);
  assert.ok(withText.length > 0, 'post text found under a known field name');
  const r1 = (await ingestItems(repo, items, { source: 'scraper', now: NOW, settings: { keywordFilter: false } })).report;
  assert.equal(r1.newListings + r1.merged + r1.dupes + r1.noText, r1.total);
  const r2 = (await ingestItems(repo, items, { source: 'scraper', now: NOW + 1, settings: { keywordFilter: false } })).report;
  assert.equal(r2.newListings, 0, 're-import is a no-op');
});

// ---------- timing ----------
function rng(seed) { let s = seed; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 2 ** 32; }
const WORDS = 'spacious bright airy east west north south facing balcony lift power backup parking covered gated community security cctv modular kitchen chimney wardrobes geyser ac washing machine fridge sofa bed dining gym pool clubhouse park garden near ecospace rmz ecoworld bellandur lake sarjapur road outer ring metro bus stop school hospital supermarket dmart quiet street corner independent house villa apartment builder floor terrace vastu tiles marble wooden flooring'.split(' ');
function synthPost(r, i, area) {
  const bhk = 1 + Math.floor(r() * 3), rent = 10000 + Math.floor(r() * 70) * 1000;
  const words = Array.from({ length: 18 + Math.floor(r() * 20) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
  const phone = '9' + String(100000000 + Math.floor(r() * 899999999));
  return { text: `${bhk}BHK ${r() < .5 ? 'semi furnished' : 'fully furnished'} flat available in ${area}, rent ${rent}, deposit ${2 + Math.floor(r() * 4)} months. ${words}. Call ${phone}`, url: `https://www.facebook.com/groups/${1 + (i % 10)}/posts/${i}/`, groupTitle: `Group ${i % 10}`, time: NOW - Math.floor(r() * 50) * 864e5 };
}

test('timing: 300 posts against 2,000 existing listings', async () => {
  const { repo } = await setup([GREEN_GLEN, { name: 'HSR', keywords: ['hsr layout', 'hsr'], active: true }]);
  const r = rng(42);
  const existing = Array.from({ length: 2000 }, (_, i) => synthPost(r, i, i % 2 ? 'Green Glen Layout' : 'HSR Layout'));
  for (let i = 0; i < existing.length; i += 500) await ingestItems(repo, existing.slice(i, i + 500), { source: 'scraper', now: NOW - 864e5 });
  const count = (await repo.listingIds()).length;
  assert.ok(count > 1900, `seeded ${count} listings`);

  // Worst case: all 300 mention a watched area; 60 are reworded reposts of existing listings, 30 exact re-scrapes.
  const batch = [];
  for (let i = 0; i < 300; i++) {
    if (i < 30) batch.push(existing[i * 7]);
    else if (i < 90) { const e = existing[i * 11]; batch.push({ ...e, url: `https://www.facebook.com/groups/99/posts/r${i}/`, text: e.text.replace('flat available', 'flat is available now') + ' Contact soon.' }); }
    else batch.push(synthPost(r, 10000 + i, i % 2 ? 'Green Glen' : 'HSR layout'));
  }
  const worst = await ingestItems(repo, batch, { source: 'scraper', now: NOW });
  assert.equal(worst.report.dupes, 30);
  assert.ok(worst.report.merged >= 55, `reposts merged: ${worst.report.merged}`);

  // Typical: 300 scraped posts, ~10 % mention the area.
  const typical = Array.from({ length: 300 }, (_, i) => synthPost(r, 20000 + i, i % 10 === 0 ? 'Green Glen' : 'Whitefield'));
  const typ = await ingestItems(repo, typical, { source: 'scraper', now: NOW + 1000 });
  const f = t => `total ${t.totalMs.toFixed(1)} ms = JS ${t.jsMs.toFixed(1)} ms + SQLite ${t.dbMs.toFixed(1)} ms; ${t.candidates} candidate rows`;
  // One dataset page at the default INGEST_PAGE_SIZE (25), all in area: the worst case for one resumable step.
  const page = Array.from({ length: 25 }, (_, i) => synthPost(r, 30000 + i, i % 2 ? 'Green Glen' : 'HSR layout'));
  const pg = await ingestItems(repo, page, { source: 'scraper', now: NOW + 2000 });
  console.log(`# ingest timing, worst case 300/300 in area: ${f(worst.timings)}`);
  console.log(`# ingest timing, typical 30/300 in area:    ${f(typ.timings)}`);
  console.log(`# ingest timing, one page 25/25 in area:    ${f(pg.timings)}`);
  assert.ok(worst.timings.totalMs < 3000, 'generous ceiling so slow CI does not flake');
  assert.ok(typ.timings.jsMs < 40, `typical batch JS time ${typ.timings.jsMs.toFixed(1)} ms (target ~10 ms; ceiling is loose for shared CI runners)`);
});

test('timing: 300-post scrape batch (10 % in area) on a small tracker, JS time per batch', async () => {
  const { repo } = await setup();
  const areas = await repo.listAreas(), settings = await repo.getSettings();
  const r = rng(7); const js = [];
  for (let k = 0; k < 5; k++) {
    const batch = Array.from({ length: 300 }, (_, i) => synthPost(r, 50000 + k * 1000 + i, i % 10 ? 'Whitefield' : 'Green Glen'));
    js.push((await ingestItems(repo, batch, { source: 'apify', now: NOW + k, areas, settings })).timings.jsMs);
  }
  const warm = js.slice(1).sort((a, b) => a - b); const median = (warm[1] + warm[2]) / 2;
  console.log(`# ingest timing, 300-post batch on a small tracker: JS median ${median.toFixed(1)} ms warm (first, cold-JIT batch ${js[0].toFixed(1)} ms)`);
  // Target is ~5 ms on a developer machine; the ceiling is looser so shared CI runners don't flake.
  assert.ok(median < 10, `median JS time ${median.toFixed(1)} ms`);
});

// QA regression: rows written by a long ingest carried the ingest *start* time as updated_at,
// so a client that synced while the ingest ran (lastSync later than that) never fetched them.
test('ingested rows are visible to an incremental refresh that synced during the ingest (QA)', async () => {
  const { repo } = await setup();
  const started = Date.now() - 60e3;              // ingest began a minute ago (multi-page dataset)
  const clientSync = Date.now() - 10e3;           // the open app refreshed 10 s ago
  await ingestItems(repo, [{ text: '2BHK available in Green Glen Layout, rent 30000, call 9000012345', url: 'https://www.facebook.com/groups/1/posts/77/' }], { source: 'apify', now: started });
  const seen = await repo.listListings({ since: clientSync - 3000 });
  assert.equal(seen.length, 1, 'the app’s next ?since= refresh returns the new listing');
});

// Store-all mode (every housing post kept, areas matched on read): every post now reaches dedupe and
// fuzzy matching, so measure one page against a tracker of mostly off-area listings.
test('timing: store-all page (no area filter) against 3,000 stored listings', async () => {
  const { repo } = await setup([GREEN_GLEN]);
  const r = rng(99);
  const seed = Array.from({ length: 3000 }, (_, i) => synthPost(r, 60000 + i, i % 10 ? 'Whitefield' : 'Green Glen'));
  for (let i = 0; i < seed.length; i += 500) await ingestItems(repo, seed.slice(i, i + 500), { source: 'apify', storeAll: true, now: NOW - 864e5 });
  assert.ok((await repo.listingIds()).length > 2500);
  const areas = await repo.listAreas(), settings = await repo.getSettings();
  const js = [];
  for (const size of [25, 25, 25, 25, 15, 15, 15, 15]) {
    const page = Array.from({ length: size }, (_, i) => i % 5 === 0 ? { ...seed[js.length * 31 + i], url: `https://www.facebook.com/groups/77/posts/s${js.length}-${i}/` } : synthPost(r, 70000 + js.length * 100 + i, i % 10 ? 'Whitefield' : 'Green Glen'));
    js.push({ size, ms: (await ingestItems(repo, page, { source: 'apify', storeAll: true, now: NOW + js.length, areas, settings })).timings.jsMs });
  }
  const med = s => { const v = js.slice(1).filter(x => x.size === s).map(x => x.ms).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  console.log(`# ingest timing, store-all page vs 3,000 listings: 25 posts JS median ${med(25).toFixed(1)} ms, 15 posts ${med(15).toFixed(1)} ms (cold first page ${js[0].ms.toFixed(1)} ms)`);
  assert.ok(med(25) < 25, `store-all 25-post page JS ${med(25).toFixed(1)} ms (loose ceiling for CI)`);
});
