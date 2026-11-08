// Shared flat vs whole home, and room rent vs whole-flat rent (a Green Glen post showed a 3BHK's 71k as a room's rent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, reparseListing } from '../src/core/logic.js';
import { publicListing } from '../src/serialize.js';
import { mergeAi } from '../src/ai.js';
import { ingestItems } from '../src/ingest.js';
import { createApp } from '../src/app.js';
import { createUserSession, COOKIE } from '../src/auth.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const pick = t => { const e = extract(t); return [e.type, e.bhk, e.rent, e.totalRent, e.rentEstimated]; };

test('a room in a shared flat: type flatmate; whole-flat rent becomes totalRent, the room gets the stated share or an estimate', () => {
  assert.deepEqual(pick('1 room available in 3BHK flat at Green Glen Layout. Rent 71000. Fully furnished.'), ['flatmate', 3, 23700, 71000, true], 'only the flat rent: estimate = total / BHK');
  assert.deepEqual(pick('One room is available in our 3 BHK apartment. Rent 72k for the flat, deposit 2L'), ['flatmate', 3, 24000, 72000, true]);
  assert.deepEqual(pick('Room available in 3bhk Green Glen, total rent 71,000, per person 24k, deposit 1 lakh'), ['flatmate', 3, 24000, 71000, null], 'stated share wins');
  assert.deepEqual(pick('Master bedroom available in 3BHK, flat rent 75k, your share 30k'), ['flatmate', 3, 30000, 75000, null]);
  assert.deepEqual(pick('Looking for a female flatmate for our 3 BHK in Bellandur. Rent 15000 for the room. Total 45k.'), ['flatmate', 3, 15000, 45000, null]);
  assert.deepEqual(pick('Private room for rent in a 2BHK, rent 18k per month including maintenance'), ['flatmate', 2, 18000, null, null], 'a normal room rent is kept');
  assert.deepEqual(pick('2BHK available, sharing for 2 boys, 12k each'), ['flatmate', 2, 12000, null, null]);
});

test('whole homes and seeking posts are unchanged', () => {
  assert.deepEqual(pick('3BHK flat for rent in Green Glen Layout, rent 71000, deposit 3 lakh'), ['flat', 3, 71000, null, null]);
  assert.deepEqual(pick('2 BHK semi furnished, rent 32k, available from 1st Dec'), ['flat', 2, 32000, null, null]);
  const s = extract('Need a room in a shared flat, budget 15k'); assert.equal(s.kind, 'seeking'); assert.equal(s.rent, 15000);
});

test('public view carries totalRent and rentEstimated (rent is public); AI cannot put the flat rent back as the room rent', () => {
  const l = { id: 'l_1', kind: 'offer', type: 'flatmate', bhk: 3, rent: 23700, totalRent: 71000, rentEstimated: true, phones: ['9000011111'], posts: [] };
  const p = publicListing(l); assert.equal(p.totalRent, 71000); assert.equal(p.rentEstimated, true); assert.equal(p.phones, undefined);
  const fields = { kind: 'offer', type: 'flatmate', bhk: '3', rent: 71000, deposit: null, depositMonths: null, maintenance: null, brokerage: null, brokerageAmount: null, furnishing: null, gender: null, availableFrom: null, society: null, locality: null, otherUnits: [], summary: 'Room in 3BHK', isRental: true };
  mergeAi(l, { fields, confidence: 0.95, bad: 0 }, { postId: 'p', model: 'm', now: 1 });
  assert.equal(l.rent, 23700);
});

test('re-check: stored listings get the new rules; user-set fields are kept; admin only; paged', async () => {
  const t = await memoryDb();
  const env = { RUNTIME: 'worker', SESSION_SECRET: 'session-secret-0123456789abcdef0123', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'x', PUBLIC_BASE_URL: 'https://hunt.test', ADMIN_EMAILS: 'boss@example.com' };
  const app = createApp({ repo: () => t.repo, assets: async () => null });
  await t.repo.createArea(GREEN_GLEN, Date.now());
  await ingestItems(t.repo, [
    { text: '1 room available in 3BHK flat at Green Glen Layout. Rent 71000. Fully furnished. aaa', url: 'https://www.facebook.com/groups/1/posts/1/', createdAt: new Date(Date.now() - 6e4).toISOString() },
    { text: 'Private room in 3BHK Green Glen Layout, rent 80000 bbb', url: 'https://www.facebook.com/groups/1/posts/2/', createdAt: new Date(Date.now() - 6e4).toISOString() },
  ], { source: 'apify', storeAll: true });
  // Simulate rows stored by the old rules: whole-flat rent as the room rent, typed as a whole flat.
  const all = await t.repo.listListings();
  for (const l of all) { l.type = 'flat'; l.rent = l.posts[0].text.includes('80000') ? 80000 : 71000; delete l.totalRent; delete l.rentEstimated; }
  all.find(l => l.rent === 80000).fieldSource = { rent: 'user' };
  await t.repo.saveIngest({ listings: all, keys: [], run: null, now: Date.now() });
  const call = async (role, body) => {
    const u = await t.repo.upsertUser({ email: role === 'admin' ? 'boss@example.com' : 'u@example.com', name: 'x', role, status: 'active' }, Date.now());
    const r = await app.fetch(new Request('https://hunt.test/api/admin/listings/reparse', { method: 'POST', headers: { cookie: `${COOKIE}=${await createUserSession(env, u.id, role)}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) }), env, {});
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await call('user', {})).status, 403);
  const r = await call('admin', { after: 0 });
  assert.deepEqual([r.status, r.data.checked, r.data.changed, r.data.done], [200, 2, 2, true]);
  const after = await t.repo.listListings();
  const a = after.find(l => l.posts[0].text.includes('71000')), b = after.find(l => l.posts[0].text.includes('80000'));
  assert.deepEqual([a.type, a.rent, a.totalRent, a.rentEstimated], ['flatmate', 23700, 71000, true]);
  assert.deepEqual([b.type, b.rent], ['flatmate', 80000], 'a rent the user set is kept; the type still updates');
  assert.equal((await call('admin', { after: r.data.next })).data.checked, 0, 'resumes after the last row');
  assert.equal((await call('admin', { after: 0 })).data.changed, 0, 'idempotent');
  assert.equal(reparseListing({ isSample: true, posts: [{ text: 'room in 3bhk rent 71000' }] }), false, 'samples are skipped');
});
