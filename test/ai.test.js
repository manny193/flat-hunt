// AI extraction: redaction, validation/grounding, merge rules, the queue pass with Workers AI and Groq
// mocked, provider fallbacks, retries, auto-merge vs merge suggestion. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redact, validateResult, mergeAi, runEnrich, numbersIn, MODELS, GROQ_URL, parseOutput, callWorkersAi, AI_FIX } from '../src/ai.js';
import { ingestItems } from '../src/ingest.js';
import { extract } from '../src/core/logic.js';
import { scoreRegex } from '../scripts/ai-eval.js';
import { memoryDb, GREEN_GLEN } from './helpers.js';

const EVAL = JSON.parse(readFileSync(new URL('./fixtures/ai-eval-posts.json', import.meta.url), 'utf8'));
const result = (id, o = {}) => ({ id, isRental: true, kind: 'offer', type: 'flat', bhk: '2', rent: 32000, deposit: null, depositMonths: null, maintenance: null, brokerage: null, brokerageAmount: null, furnishing: null, gender: null, availableFrom: null, society: null, locality: null, otherUnits: [], summary: 's', confidence: 0.9, ...o });

test('redaction: phones, emails and links never reach a model', () => {
  const r = redact('Call +91 98765 43210 or 9876543210, mail a.b@example.com, map https://maps.app.goo.gl/x wa.me/919876543210 <script>');
  assert.doesNotMatch(r, /\d{5}|example\.com|goo\.gl|wa\.me|<|>/);
  assert.match(r, /\[PHONE\].*\[EMAIL\].*\[LINK\]/);
});

test('validation: schema enums, bounds, grounding of every number, dates near the post date', () => {
  const text = '2bhk semi furnished 32k + 2.5k maint, deposit 2L, 3 months advance, avail 1st dec. Green Glen Layout';
  assert.deepEqual([...numbersIn(text)].filter(n => n > 100).sort((a, b) => a - b), [2500, 32000, 200000]);
  const v = validateResult(result('P1', { rent: 32000, maintenance: 2500, deposit: 250000, depositMonths: 3, furnishing: 'semi', gender: 'robot', availableFrom: '2026-12-01', locality: 'Green Glen Layout', society: 'Prestige Lakeside' }), text, Date.UTC(2026, 10, 5));
  assert.equal(v.fields.rent, 32000); assert.equal(v.fields.maintenance, 2500);
  assert.equal(v.fields.deposit, null, '2,50,000 is not written in the post'); assert.equal(v.fields.depositMonths, 3);
  assert.equal(v.fields.gender, null); assert.equal(v.fields.society, null, 'society must appear in the text'); assert.equal(v.fields.locality, 'Green Glen Layout');
  assert.equal(v.bad, 3);
  assert.equal(validateResult(result('P1', { availableFrom: '2031-01-01' }), text, Date.UTC(2026, 10, 5)).fields.availableFrom, null);
  assert.equal(validateResult(result('P1', { rent: 999999999 }), text).fields.rent, null);
  assert.deepEqual(parseOutput('<think>hmm</think> sure: {"results":[]} thanks'), { results: [] });
});

test('merge rules: phones stay regex, AI wins meaning fields, money only when grounded and confident, user edits win', () => {
  const l = { id: 'l1', kind: 'offer', type: 'flat', rent: 30000, deposit: null, bhk: 2, phones: ['9000012345'], gender: null, fieldSource: { furnishing: 'user' }, furnishing: 'fully' };
  const text = 'Room for working girls in 2bhk, 30k, deposit 60k, semi furnished, brokerage nahi';
  const v = validateResult(result('P1', { type: 'flatmate', gender: 'female', rent: 30000, deposit: 60000, furnishing: 'semi', brokerage: 'no', confidence: 0.6, otherUnits: [{ label: '3BHK', bhk: '3', rent: 30000 }] }), text);
  const r = mergeAi(l, v, { postId: 'p', model: 'm', now: 1 });
  assert.equal(l.type, 'flatmate'); assert.equal(l.gender, 'female'); assert.equal(l.brokerage, 'no');
  assert.equal(l.deposit, 60000, 'regex was empty'); assert.equal(l.furnishing, 'fully', 'user edit wins');
  assert.deepEqual(l.phones, ['9000012345']); assert.equal(l.multiFlat, true); assert.equal(l.aiStatus, 'done');
  assert.equal(l.regex.type, 'flat', 'regex value kept'); assert.ok(r.final <= 0.6);
  const l2 = { id: 'l2', rent: 25000, kind: 'offer' };
  mergeAi(l2, validateResult(result('P1', { rent: 26000, confidence: 0.6 }), 'rent 25000 or 26000'), { now: 1 });
  assert.equal(l2.rent, 25000, 'low confidence does not override regex money'); assert.deepEqual(l2.conflicts.rent, [25000, 26000]);
  const l3 = { id: 'l3', kind: 'offer' };
  mergeAi(l3, validateResult(result('P1', { isRental: false, confidence: 0.95, bhk: null, rent: null }), 'selling sofa'), { now: 1 });
  assert.equal(l3.kind, 'not_rental');
});

async function setup() {
  const t = await memoryDb();
  const gg = await t.repo.createArea(GREEN_GLEN, Date.now());
  const hsr = await t.repo.createArea({ name: 'HSR', keywords: ['hsr layout'], active: true }, Date.now());
  const u = await t.repo.upsertUser({ email: 'u@example.com' }, Date.now());
  await t.repo.linkArea(u.id, gg.id, Date.now());
  const posts = [
    { text: '2bhk in Green Glen Layout 32k rent, deposit 2L, call 9000012345, owner', url: 'https://www.facebook.com/groups/1/posts/1/' },
    { text: 'Flatmate needed Green Glen Layout, 3bhk, 14k per head, girls only, 9000054321', url: 'https://www.facebook.com/groups/1/posts/2/' },
    { text: '1BHK in HSR Layout rent 22000 call 9000099999', url: 'https://www.facebook.com/groups/1/posts/3/' },
  ];
  await ingestItems(t.repo, posts, { source: 'apify', storeAll: true });
  return { ...t, gg, hsr, u };
}
function fakeAI(handler) {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); return handler(model, input, calls.length); } };
}
const idsIn = input => [...input.messages.at(-1).content.matchAll(/<post id="(P\d+)"/g)].map(m => m[1]);

test('enrich pass: only followed areas are queued, Workers AI results merged, neurons counted, phones never sent', async () => {
  const t = await setup();
  const AI = fakeAI((model, input) => ({ response: { results: idsIn(input).map(id => result(id, { rent: input.messages.at(-1).content.includes('14k') && id === 'P1' ? 14000 : null, type: null, bhk: null, gender: 'female', confidence: 0.9 })) }, usage: { prompt_tokens: 2000, completion_tokens: 400 } }));
  const r = await runEnrich(t.repo, { AI }, { maxCalls: 4 });
  assert.equal(r.done, 2, 'the HSR listing is in no followed area'); assert.equal(AI.calls.length, 1);
  assert.equal(AI.calls[0].model, MODELS.primary);
  assert.deepEqual(AI.calls[0].input.response_format.type, 'json_schema');
  assert.doesNotMatch(JSON.stringify(AI.calls[0].input), /9000\d{6}/, 'no phone digits sent');
  const all = await t.repo.listListings();
  const gg = all.filter(l => l.areas.includes(t.gg.id));
  assert.ok(gg.every(l => l.aiStatus === 'done' && l.gender === 'female' && l.phones.length === 1));
  assert.equal(all.find(l => l.areas.includes(t.hsr.id)).aiStatus, '');
  const s = (await t.repo.getSettings()).ai;
  assert.equal(s.neurons, Math.ceil((2000 * 9091 + 400 * 27273) / 1e6)); assert.equal(s.posts, 2);
  assert.equal((await runEnrich(t.repo, { AI })).action, 'idle', 'nothing left');
});

test('provider fallbacks: unavailable Gemma -> gpt-oss on Workers AI; daily allocation (3036) -> Groq; failures back off then fail', async () => {
  const t = await setup();
  const AI = fakeAI(model => { if (model === MODELS.primary) throw new Error('5007: No such model @cf/google/gemma-4-26b-a4b-it'); throw new Error('AiError: 3036: You have used up your daily free allocation of 10,000 neurons'); });
  const groq = [];
  const fetchFn = async (url, init) => { assert.equal(url, GROQ_URL); const b = JSON.parse(init.body); groq.push(b); assert.equal(b.model, 'openai/gpt-oss-20b'); assert.equal(b.response_format.json_schema.strict, true);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: [...b.messages.at(-1).content.matchAll(/<post id="(P\d+)"/g)].map(m => result(m[1], { rent: null, bhk: null, type: null })) }) } }], usage: { total_tokens: 900 } }); };
  const r = await runEnrich(t.repo, { AI, GROQ_API_KEY: 'gk' }, { fetchFn });
  assert.deepEqual(AI.calls.map(c => c.model), [MODELS.primary, MODELS.cfFallback]);
  assert.equal(groq.length, 1); assert.equal(r.done, 2); assert.equal(r.provider, 'groq');
  const s = (await t.repo.getSettings()).ai;
  assert.equal(s.cfModel, MODELS.cfFallback); assert.ok(s.cfPausedUntil > Date.now());

  const t2 = await setup();
  const bad = fakeAI(() => ({ response: 'not json at all' }));
  let now = Date.now();
  const r2 = await runEnrich(t2.repo, { AI: bad }, { now, maxCalls: 4 });
  assert.equal(r2.retry, 2, 'invalid JSON -> retry'); assert.equal(bad.calls.length, 3, 'batch, then one post at a time');
  assert.equal((await runEnrich(t2.repo, { AI: bad }, { now: now + 60e3 })).action, 'idle', 'backoff: not due yet');
  for (let i = 0; i < 5; i++) { now += 24 * 36e5; await runEnrich(t2.repo, { AI: bad }, { now, maxCalls: 4 }); }
  const st = await t2.repo.aiStats(now);
  assert.equal(st.byStatus.failed, 2); assert.equal(st.failures.length, 2);
  assert.ok((await t2.repo.listListings()).filter(l => l.aiStatus === 'failed').length === 2, 'regex values stay, listing marked failed');
});

test('re-dedupe after AI: same phone + BHK + rent within 2 % auto-merges; otherwise a merge suggestion', async () => {
  const t = await memoryDb();
  const gg = await t.repo.createArea(GREEN_GLEN, Date.now());
  const u = await t.repo.upsertUser({ email: 'u@example.com' }, Date.now()); await t.repo.linkArea(u.id, gg.id, Date.now());
  await ingestItems(t.repo, [
    { text: '2BHK Green Glen Layout rent 30000 lake view tower alpha, 9000011111', url: 'https://www.facebook.com/groups/1/posts/1/', createdAt: new Date(Date.now() - 36e5 * 30).toISOString() },
    { text: 'Spacious flat on 2nd floor in Green Glen Layout, 30k, big balcony gamma delta, 9000011111', url: 'https://www.facebook.com/groups/1/posts/2/' },
    { text: '2BHK Green Glen Layout 30,200 rent, other building omega sigma, 9000022222', url: 'https://www.facebook.com/groups/1/posts/3/', createdAt: new Date(Date.now() - 36e5 * 40).toISOString() },
  ], { source: 'apify', storeAll: true });
  assert.equal((await t.repo.listListings()).length, 3);
  const old = (await t.repo.listListings()).find(l => l.rent === 30000 && l.bhk === 2);
  await t.repo.updateListingFields(old.id, { status: 'approved', stage: 'To call', notes: 'keep', decidedAt: 1 }, Date.now(), u.id);
  // The AI reads the newest post (no BHK in regex) and finds 2 BHK at 30k.
  const AI = fakeAI((m, input) => ({ response: { results: idsIn(input).map(id => result(id, { bhk: '2', rent: input.messages.at(-1).content.includes('balcony') && id === 'P1' ? 30000 : null, type: null })) } }));
  await t.repo.db.run("UPDATE listings SET ai_status = 'done' WHERE id != (SELECT id FROM listings WHERE data LIKE '%balcony%')");
  const r = await runEnrich(t.repo, { AI });
  assert.equal(r.merged, 1); assert.equal(r.suggestions, 1);
  const left = await t.repo.listListings();
  assert.equal(left.length, 2);
  const merged = left.find(l => l.phones.includes('9000011111'));
  assert.equal(merged.posts.length, 2); assert.equal(merged.seenCount, 2);
  assert.equal((await t.repo.getListing(merged.id, u.id)).notes, 'keep', 'user state moved to the kept listing');
  const sg = await t.repo.listSuggestions();
  assert.equal(sg.length, 1); assert.match(sg[0].reason, /different or missing phone/);
});

test('ai-eval offline: regex scores on the labelled set (baseline from the research doc or better)', () => {
  const s = scoreRegex(EVAL.posts, extract);
  assert.equal(s.n, 31);
  assert.ok(s.fields.rent >= 31 && s.fields.bhk >= 31, JSON.stringify(s.fields));
  assert.ok(s.fields.deposit >= 31, 'e08 regex fix: deposit now right on every post');
  assert.ok(s.critical >= 22, `critical rows ${s.critical}`);
});

// Production, Nov 2026: Workers AI now answers in the chat-completion shape, and both models think first. With
// thinking on, the whole max_tokens went to reasoning_content and content was "" (finish_reason "length"):
// every call failed as "invalid JSON". These replies mirror what the REST API returned.
const chatReply = (content, finish = 'stop', reasoning = '') => ({ id: 'x', object: 'chat.completion', model: MODELS.primary, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, reasoning_content: reasoning } }], usage: { prompt_tokens: 1359, completion_tokens: finish === 'length' ? 500 : 134 } });

test('Workers AI: thinking is off for Gemma and low for gpt-oss; a thinking-only reply says why it failed', async () => {
  const items = [{ text: '2BHK for rent in HSR, rent 32k', postedAt: Date.now() }];
  const seen = [];
  const ok = { run: async (model, input) => { seen.push({ model, input }); return chatReply(JSON.stringify({ results: [result('P1')] })); } };
  const r = await callWorkersAi({ AI: ok }, MODELS.primary, items);
  assert.equal(r.parsed.results[0].rent, 32000); assert.equal(r.why, null);
  assert.deepEqual(seen[0].input.chat_template_kwargs, { enable_thinking: false });
  await callWorkersAi({ AI: ok }, MODELS.cfFallback, items);
  assert.equal(seen[1].input.reasoning_effort, 'low'); assert.equal(seen[1].input.chat_template_kwargs, undefined);

  const thinking = { run: async () => chatReply('', 'length', '*   Post ID: P1\n    *   `isRental`: true ...') };
  const bad = await callWorkersAi({ AI: thinking }, MODELS.primary, items);
  assert.equal(bad.parsed, null);
  assert.match(bad.why, /token limit thinking/);
  assert.match(bad.why, /invalid JSON/, 'still matches the requeue filter');
});

test('after the fix, posts that failed with a parse error are retried once; other failures are left alone', async () => {
  const t = await setup();
  let now = Date.now();
  const thinking = fakeAI(() => chatReply('', 'length', 'thinking...'));
  // The bug: five runs of thinking-only replies take both followed posts to 'failed'.
  await t.repo.putSettings({ ai: { requeuedFix: AI_FIX } });
  for (let i = 0; i < 6; i++) { await runEnrich(t.repo, { AI: thinking }, { now, maxCalls: 4 }); now += 24 * 36e5; }
  let st = await t.repo.aiStats(now);
  assert.equal(st.byStatus.failed, 2);
  assert.match(st.failures[0].error, /token limit thinking/, 'the admin page shows the real reason');
  // A failure that is not a parse error stays failed.
  await t.repo.db.run("UPDATE ai_queue SET error = 'listing or post gone' WHERE rowid = (SELECT min(rowid) FROM ai_queue WHERE status = 'failed')");
  // Deploy of the fix: the next run requeues parse failures once and reads them.
  await t.repo.putSettings({ ai: { ...(await t.repo.getSettings()).ai, requeuedFix: AI_FIX - 1 } });
  const good = fakeAI((model, input) => chatReply(JSON.stringify({ results: idsIn(input).map(id => result(id, { rent: null, bhk: null, type: null })) })));
  const r = await runEnrich(t.repo, { AI: good }, { now, maxCalls: 4 });
  assert.equal(r.done, 1, 'the parse failure was retried and read');
  st = await t.repo.aiStats(now);
  assert.equal(st.byStatus.failed, 1, 'the other failure is untouched');
  assert.equal((await t.repo.getSettings()).ai.requeuedFix, AI_FIX);
  // Once only: a later parse failure is not requeued again by this fix.
  assert.equal((await runEnrich(t.repo, { AI: good }, { now: now + 60e3 })).action, 'idle');
});

test('a sale our rules found is not turned back into an offer by a low-confidence AI result', () => {
  const fields = { ...result('P1'), isRental: true, kind: 'offer', type: 'flat', bhk: '3', rent: null };
  const l = { id: 'l_s', kind: 'not_rental', type: 'flatmate', posts: [] };
  mergeAi(l, { fields: { ...fields, confidence: 0.61 }, confidence: 0.61, bad: 0 }, { postId: 'p', model: 'm', now: 1 });
  assert.equal(l.kind, 'not_rental', 'production case: AI said offer at 0.61');
  const sure = { id: 'l_t', kind: 'not_rental', type: 'flat', posts: [] };
  mergeAi(sure, { fields: { ...fields, confidence: 0.95 }, confidence: 0.95, bad: 0 }, { postId: 'p', model: 'm', now: 1 });
  assert.equal(sure.kind, 'offer', 'a confident AI may still correct the rules');
});
