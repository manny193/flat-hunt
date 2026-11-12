// Listing quality (founder feedback, 9 Nov 2026): sale/investment posts and "looking for a room" posts are not
// offers; a room's bathroom (attached or not) is stored and filterable; a post's own text decides its area, not
// the group's name; stored listings get re-checked automatically after a rule change.
// Texts are real posts from production with phone numbers and names replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, postAreas, namesPlace, bathOf, reparseListing, makeContext, RULES_VERSION } from '../src/core/logic.js';
import { ingestItems } from '../src/ingest.js';
import { publicListing } from '../src/serialize.js';
import { reparseStep, reparsePage, CRON_QUERIES } from '../src/reparse.js';
import { budgeted } from '../src/apify.js';
import { startBackfill } from '../src/backfill.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const SALE = `👑 Codename Basavanagudi: An Address That Stands Apart. 👑
Sunlight pours effortlessly into a palatial 2,500 sq. ft. living space. Just you and 11 other distinguished families sharing 3.5 acres of pristine landscape.
Palatial Scale: Massive 3 BHK configurations where every room feels like a master suite.
🔑 Possession: 2028
💎 Investment: 3 BHK starting at ₹8 Crore
This is a rare heirloom asset. We are now inviting Expressions of Interest (EOI) for these exclusive homes.
📱 Agent | +91 9000000001
AUTHORISED CHANNEL PARTNER`;
const SEEKING = `3bhk room with balcony and pool in Bellandur
Hi all
Looking for a spacious room (attached washroom and balcony) in a preoccupied 3bhk in a gated society with amenities like (swimming pool ,gym,badminton court) and rent within 20-21k`;
const SEPARATE_BATH = `# 🏠 **Flatmate Replacement | Private Room in 3BHK | Sobha Primrose, Bangalore**
Looking for a flatmate to take over a room in a spacious **3BHK apartment at Sobha Primrose, Green Glen Layout, Bangalore!** 🏡
🛏️ **Room Details**
* Private room in a 3BHK flat
* Personal bathroom (not attached to the bedroom)
📅 **Available From:** 15th November
* **Rent:** ₹21,300/month
* **Security Deposit:** ₹1,00,000 (fully refundable)
✅ **No brokerage charges!**
✨ A great option for anyone looking for a comfortable home with excellent amenities!
* **Call / WhatsApp:** 9000000002
#FlatAndFlatmates #FlatmateReplacement #GreenGlenLayout`;
const ROOM_71K = `🏡 SPACIOUS 3BHK | LOOKING FOR A FEMALE FLATMATE | GREEN GLEN LAYOUT
✨ Trying to close ASAP – available immediately!
We are two females looking for a third female flatmate to join us in a beautiful, spacious 3BHK (1800 sq. ft.) semi-furnished apartment at Green Glen Layout.
The available room is the second bedroom and comes with a private, attached bathroom.
💰 Financial Breakdown
* Total rent: 71k (66k + 5k maintenance)
* November rent: 35.5k divided by 3 (half-month rent, as the move-in date is 15th November)
* Available room rent: 22k + maintenance
* Security deposit: 2lakh (divided by 3)
If you're a female looking for a spacious home in a great location with easygoing flatmates, this could be the one!`;
const HSR = `🏙️ 1bhk Semi-Furnished Flat for Rent HSR Layout "ITI LAYOUT" Bangalore.
🌌#rent : ₹24k including maintenance
🌌#Deposit :  75k
✅Family or Bachelors
👍🔜contact or WhatsApp us on ☎️9000000003☎️
✅ BROKERAGE APPLICABLE
#1rkflat  #HSRLayout #hsrlayoutsector1 #1bhkflat #1BHKForRent #flats #flatforrent #flatmates #bangalore #houseforrent`;
const JB_NAGAR = `1BHK JEEVAN BHIMA NAGAR
NEAR INDIRA NAGAR
RENT 27K 4MONTH DEPOSIT
LIFT, CCTV
BROKERAGE APPLICABLE
9000000004`;
const GROUP = 'Flat And Flatmate Bellandur Green Glen';

test('1. sale / investment posts are not rentals', () => {
  assert.equal(extract(SALE).kind, 'not_rental');
  assert.equal(extract('3BHK for sale in Bellandur, 1.6 Cr, ready to move').kind, 'not_rental');
  assert.equal(extract('Resale 2BHK at Sobha, 95 lakh negotiable, khata ready').kind, 'not_rental');
  assert.equal(extract('New launch: 2 & 3 BHK luxury apartments, RERA approved, possession Dec 2027').kind, 'not_rental');
  // Rentals that happen to use one of these words stay offers.
  assert.equal(extract('2BHK for rent near Bellandur, rent 30k, deposit 1 lakh, possession immediately').kind, 'offer');
  assert.equal(extract('Room available in 3BHK, good investment of your money haha, rent 15000 per month').kind, 'offer');
});

test('2. people looking for a place are seeking, not offers; offers that say "looking for a flatmate" stay offers', () => {
  assert.equal(extract(SEEKING).kind, 'seeking');
  assert.equal(extract('Looking for a fully furnished 2bhk near HSR, budget 35k').kind, 'seeking');
  assert.equal(extract('I am looking for a room in HSR, available to move in from 1st Dec, budget 15k').kind, 'seeking');
  assert.equal(extract('Need a single room urgently near Marathahalli').kind, 'seeking');
  assert.equal(extract(ROOM_71K).kind, 'offer');
  assert.equal(extract(SEPARATE_BATH).kind, 'offer', '"for anyone looking for a comfortable home" is the offer’s closing line');
  assert.equal(extract('Need a tenant for my 2bhk flat in Bellandur, rent 30k').kind, 'offer');
  assert.equal(extract('We are looking for a female flatmate for our 3bhk, rent 20k').kind, 'offer');
  assert.equal(extract('I’m looking for accommodation near Bagmane, rent upto 70k. If you have leads, available flats, or are also looking for a flatmate to team up, DM me').kind, 'seeking', 'curly apostrophe; a flatmate ask addressed to the reader');
  assert.equal(extract('Join our flat and flatmates group for 2BHK house listings in HSR, rent 35k').type, 'flat', 'a pasted group name is not a shared room');
  assert.equal(extract('2 BHK in Koramangala 4th block near St Bed main road, rent 52k, only for family').type, 'flat', 'St Bed is a place');
});

test('3. bathroom of a room: attached or not, shown and filterable; whole flats carry none', () => {
  assert.equal(extract(ROOM_71K).bath, 'attached');
  assert.equal(extract(SEPARATE_BATH).bath, 'separate');
  assert.equal(extract('Room available in 2BHK with attached washroom, rent 18k').bath, 'attached');
  assert.equal(extract('Private room for rent, common bathroom, 12k').bath, 'separate');
  assert.equal(extract('Room available in 3bhk, rent 15k').bath, null);
  assert.equal(extract('3BHK for rent, 3 attached bathrooms, rent 60k').bath, null, 'a whole flat');
  assert.equal(bathOf('room with en-suite bathroom'), 'attached');
  assert.equal(publicListing({ id: 'l_x', kind: 'offer', type: 'flatmate', bath: 'attached', posts: [] }).bath, 'attached', 'public: bath is not personal data');
});

test('4/5. the post text decides the area; the group name only fills in when the text names no place', () => {
  const ctx = makeContext([{ id: 1, ...GREEN_GLEN }], {});
  assert.deepEqual(postAreas(HSR, GROUP, ctx.areas), [], 'HSR Layout post in the Bellandur Green Glen group');
  assert.deepEqual(postAreas(JB_NAGAR, GROUP, ctx.areas), [], 'Jeevan Bhima Nagar / Indiranagar post');
  assert.deepEqual(postAreas(SEPARATE_BATH, GROUP, ctx.areas), [1], 'names Green Glen');
  assert.deepEqual(postAreas('1 room available in 2BHK, rent 15k, call 9000000005', GROUP, ctx.areas), [1], 'names no place: the group says where');
  assert.deepEqual(postAreas('1BHK for rent, 20k', 'Flats and Flatmates Bangalore', ctx.areas), []);
  assert.ok(namesPlace('Flat in INDRANAGAR') && namesPlace('#HSRLayout') && namesPlace('Koramangala 5th block') && !namesPlace('Room available in 3BHK'));
  // Hashtag spam ("#flatmates") does not make a whole 1BHK a shared room.
  assert.equal(extract(HSR).type, 'flat');
  assert.equal(extract(JB_NAGAR).type, 'flat');
});

test('ingest: sale and seeking posts are stored but not on the homepage; areas come from the text', async () => {
  const t = await memoryDb();
  const gg = await t.repo.createArea(GREEN_GLEN, Date.now());
  const at = new Date(Date.now() - 6e4).toISOString();
  const r = await ingestItems(t.repo, [SALE, SEEKING, HSR, JB_NAGAR, ROOM_71K].map((text, i) => ({ text, url: `https://www.facebook.com/groups/1/posts/${i + 1}/`, groupName: GROUP, createdAt: at })), { source: 'apify', storeAll: true });
  assert.equal(r.report.notRental, 1); assert.equal(r.report.seeking, 1);
  const offers = await t.repo.publicListings({ kind: 'offer' });
  assert.deepEqual(offers.map(l => l.posts[0].text.slice(0, 12)).sort(), [HSR, JB_NAGAR, ROOM_71K].map(x => x.slice(0, 12)).sort());
  const inGG = await t.repo.publicListings({ area: gg.id, kind: 'offer' });
  assert.deepEqual(inGG.map(l => l.rent), [22000], 'only the Green Glen room; HSR and JB Nagar are not filed under Green Glen');
  assert.equal(inGG[0].bath, 'attached');
});

test('6. re-check fixes stored listings: room rent, kind, bath, type and areas; cron runs it once per rules version', async () => {
  const t = await memoryDb();
  const gg = await t.repo.createArea(GREEN_GLEN, Date.now());
  const at = new Date(Date.now() - 6e4).toISOString();
  await ingestItems(t.repo, [SALE, SEEKING, HSR, JB_NAGAR, ROOM_71K, SEPARATE_BATH].map((text, i) => ({ text, url: `https://www.facebook.com/groups/1/posts/${i + 1}/`, groupName: GROUP, createdAt: at })), { source: 'apify', storeAll: true });
  // Simulate rows stored by the old rules (what production holds today).
  const all = await t.repo.listListings();
  for (const l of all) { l.kind = 'offer'; l.areas = [gg.id]; delete l.bath; if (l.posts[0].text === ROOM_71K) { l.rent = 71000; delete l.totalRent; } if (l.posts[0].text === HSR) l.type = 'flatmate'; }
  await t.repo.saveIngest({ listings: all, keys: [], run: null, now: Date.now() });
  assert.equal((await t.repo.publicListings({ area: gg.id })).length, 6);

  const s1 = await reparseStep(t.repo);
  assert.equal(s1.version, RULES_VERSION); assert.ok(s1.doneAt, 'six listings fit one cron page'); assert.equal(s1.changed, 6);
  assert.equal(await reparseStep(t.repo), null, 'nothing to do until the rules change again');
  const by = new Map((await t.repo.listListings()).map(l => [l.posts[0].text, l]));
  assert.deepEqual([by.get(ROOM_71K).rent, by.get(ROOM_71K).totalRent, by.get(ROOM_71K).bath], [22000, 71000, 'attached']);
  assert.equal(by.get(SALE).kind, 'not_rental');
  assert.equal(by.get(SEEKING).kind, 'seeking');
  assert.equal(by.get(SEPARATE_BATH).bath, 'separate');
  assert.deepEqual([by.get(HSR).type, by.get(HSR).areas], ['flat', []]);
  assert.deepEqual(by.get(JB_NAGAR).areas, []);
  const inGG = await t.repo.publicListings({ area: gg.id });
  assert.deepEqual(inGG.map(l => l.rent).sort(), [21300, 22000], 'Green Glen now holds only the two Green Glen rooms');

  // A user's decision is never undone; a rules version bump re-runs the whole pass.
  const room = by.get(SEPARATE_BATH); room.kind = 'seeking'; room.fieldSource = { kind: 'user', bath: 'user' }; room.bath = 'attached';
  await t.repo.saveIngest({ listings: [room], keys: [], run: null, now: Date.now() });
  await t.repo.putSettings({ reparse: { version: RULES_VERSION - 1, doneAt: 1 } });
  const s2 = await reparseStep(t.repo); assert.equal(s2.version, RULES_VERSION); assert.equal(s2.checked, 6);
  const kept = (await t.repo.listListings()).find(l => l.id === room.id);
  assert.deepEqual([kept.kind, kept.bath], ['seeking', 'attached']);
  assert.equal((await reparsePage(t.repo, { after: 0 })).changed, 0, 'idempotent');
});

test('6b. room rent rules found by the production dry run (rows the re-check would otherwise get wrong)', () => {
  const r = t => { const e = extract(t); return [e.rent, e.totalRent, e.rentEstimated]; };
  assert.deepEqual(r('The Room:\n✨ Attached bathroom\n✨ In a fully furnished flat\nRent: ₹26,000/month (including maintenance)\nDeposit: 1L'), [26000, null, null], '"flat" at a line end + "Rent:" is not a whole-flat rent');
  assert.deepEqual(r('Master bedroom available in a 3 BHK apartment\n💰 Rent: ₹22,000 per month\n💰 Maintenance: ₹2,000 per month\nTotal: ₹24,000 per month'), [22000, null, null], 'rent + maintenance total is the room’s cost');
  assert.deepEqual(r('Two rooms available in our 2BHK for flatmates\nRoom 1: ₹16,000/month Attached bathroom\nRoom 2: ₹14,000/month\nTotal flat rent: ₹30,000'), [16000, 30000, null], 'a priced room is a share');
  assert.deepEqual(r('1 room available in 3BHK flat at Green Glen Layout. Rent 71000.'), [23700, 71000, true], 'unchanged: whole-flat rent only');
});

test('re-check keeps tags of paused areas; area backfill reads post text, not group names', async () => {
  const ctx = makeContext([{ id: 1, ...GREEN_GLEN }, { id: 2, name: 'Old', keywords: ['old area'], active: false }], {});
  const l = { kind: 'offer', type: 'flat', areas: [1, 2], posts: [{ text: HSR, group: GROUP }] };
  assert.equal(reparseListing(l, ctx), true); assert.deepEqual(l.areas, [2]);

  const t = await memoryDb();
  await ingestItems(t.repo, [{ text: HSR, url: 'https://www.facebook.com/groups/1/posts/9/', groupName: GROUP }, { text: SEPARATE_BATH, url: 'https://www.facebook.com/groups/1/posts/10/', groupName: 'Flats and Flatmates Bangalore' }], { source: 'apify', storeAll: true });
  const gg = await t.repo.createArea(GREEN_GLEN, Date.now());
  await startBackfill(t.repo, gg, Date.now());
  const tagged = await t.repo.publicListings({ area: gg.id });
  assert.deepEqual(tagged.map(x => x.rent), [21300], 'the HSR post is not tagged because its group name says Green Glen');
});

test('senior review: offers that the new sale/seeking/area rules must not hide', () => {
  const ctx = makeContext([{ id: 1, ...GREEN_GLEN }], {});
  assert.equal(namesPlace('2bhk with big hall and kitchen'), false, '"hall" is not HAL');
  assert.equal(namesPlace('near HAL airport road'), true);
  assert.deepEqual(postAreas('2BHK with spacious hall, 30k', GROUP, ctx.areas), [1], 'a hall does not cancel the group fallback');
  assert.equal(extract('We are looking to rent out our 2BHK flat in HSR. Rent 35k, deposit 1L.').kind, 'offer');
  assert.equal(extract('Looking to give our 1BHK on rent, Koramangala, 22k').kind, 'offer');
  assert.equal(extract('2BHK semi furnished available in Bellandur, immediate possession, registration not needed, 28k').kind, 'offer');
  assert.equal(extract('3BHK flat, ready to occupy, khata done. Rent negotiable. Owner').kind, 'offer');
  assert.equal(extract('Tenants required for 2BHK flat in HSR, rent 30k').kind, 'offer');
  assert.equal(extract('3BHK villa, 2.5 Cr, ready to occupy, available now').kind, 'not_rental', 'strong sale wording still wins over "available"');
});

test('re-check: the rules’ own not_rental can be undone, the AI’s cannot; a cron tick fits CRON_QUERIES', async () => {
  const text = '3BHK flat, ready to occupy, khata done. Rent negotiable. Owner';
  const rules = { kind: 'not_rental', type: 'flat', posts: [{ text }] };
  assert.equal(reparseListing(rules), true); assert.equal(rules.kind, 'offer');
  const ai = { kind: 'not_rental', type: 'flat', ai: { fields: { isRental: false } }, posts: [{ text }] };
  assert.equal(reparseListing(ai), false); assert.equal(ai.kind, 'not_rental');

  const t = await memoryDb();
  await t.repo.createArea(GREEN_GLEN, Date.now());
  const now = Date.now();
  const stale = Array.from({ length: 12 }, (_, i) => ({ id: 'l_q' + i, kind: 'offer', type: 'flatmate', bhk: 3, rent: 71000, areas: [1], createdAt: now, lastPostedAt: now, posts: [{ id: 'p' + i, text: ROOM_71K, th: 'h' + i }] }));
  await t.repo.saveIngest({ listings: stale, keys: [], run: null, now });
  const br = budgeted(t.repo);
  const st = await reparseStep(br);
  assert.equal(st.changed, 10, 'one full cron page changed');
  assert.ok(br.used() <= CRON_QUERIES, `cron tick used ${br.used()} queries (guard ${CRON_QUERIES})`);
});

test('area counts match what the homepage shows: hidden sale/seeking posts and samples are not counted', async () => {
  const t = await memoryDb();
  const gg = await t.repo.createArea(GREEN_GLEN, Date.now());
  const at = new Date(Date.now() - 6e4).toISOString();
  await ingestItems(t.repo, [SALE, SEEKING, ROOM_71K, SEPARATE_BATH].map((text, i) => ({ text: text + ' Green Glen', url: `https://www.facebook.com/groups/1/posts/${i + 80}/`, createdAt: at })), { source: 'apify', storeAll: true });
  await ingestItems(t.repo, [{ text: '2BHK for rent in Green Glen Layout, rent 30000, deposit 1 lakh', url: 'https://www.facebook.com/groups/1/posts/99/', createdAt: at }], { source: 'sample', storeAll: true, sample: true });
  const shown = (await t.repo.publicListings({ area: gg.id })).length;
  const [st] = await t.repo.areaStats(Date.now());
  assert.equal(shown, 2, 'two offers on the homepage');
  assert.deepEqual([st.listings, st.listings7d], [shown, shown], 'picker count = homepage count');
});

test('re-check restores not_rental over a weak AI "offer" (RULES_VERSION 3), not over a confident one', () => {
  const weak = { kind: 'offer', type: 'flat', fieldSource: { kind: 'ai', type: 'ai' }, ai: { confidence: 0.61, fields: { isRental: true, kind: 'offer' } }, posts: [{ text: SALE }] };
  assert.equal(reparseListing(weak), true);
  assert.equal(weak.kind, 'not_rental'); assert.equal(weak.fieldSource.kind, 'rules'); assert.equal(weak.fieldSource.type, 'ai', 'other AI fields untouched');
  const sure = { kind: 'offer', type: 'flat', fieldSource: { kind: 'ai' }, ai: { confidence: 0.9, fields: { isRental: true, kind: 'offer' } }, posts: [{ text: SALE }] };
  reparseListing(sure); assert.equal(sure.kind, 'offer');
  const user = { kind: 'offer', type: 'flat', fieldSource: { kind: 'user' }, ai: { confidence: 0.5 }, posts: [{ text: SALE }] };
  reparseListing(user); assert.equal(user.kind, 'offer', 'a user decision always wins');
});
