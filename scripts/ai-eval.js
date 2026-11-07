// AI extraction eval (docs/AI-EXTRACTION.md section 5) on test/fixtures/ai-eval-posts.json.
//   npm run ai-eval                 offline: scores the regex extractor only (no network)
//   npm run ai-eval -- --online     also runs the model through the Cloudflare REST API and scores
//                                   AI-only and merged (regex + AI) per field. Needs CLOUDFLARE_ACCOUNT_ID and
//                                   CLOUDFLARE_API_TOKEN (Workers AI: Read). Options: --model=<id> --batch=<n>
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extract } from '../src/core/logic.js';
import { SYSTEM, FEW_SHOT, SCHEMA, MODELS, redact, validateResult, mergeAi, parseOutput, batchMessage } from '../src/ai.js';

export const FIELDS = ['kind', 'type', 'bhk', 'rent', 'deposit', 'depositMonths', 'maintenance', 'brokerage', 'brokerageAmount', 'furnishing', 'gender', 'availableFrom', 'society', 'phones'];
export const CRITICAL = ['kind', 'type', 'bhk', 'rent', 'deposit', 'brokerage'];
const norm = (k, v) => {
  if (v == null || v === '') return null;
  if (k === 'bhk') return String(v).toUpperCase();
  if (k === 'phones') return [...v].map(String).sort().join(',') || null;
  if (typeof v === 'string') return v.trim().toLowerCase();
  return v;
};
export function same(k, got, want) {
  const g = norm(k, got), w = norm(k, want);
  if (k === 'society' || k === 'locality') return g == null || w == null ? g === w : g.includes(w) || w.includes(g);
  if (k === 'availableFrom' && w === 'immediate' && typeof g === 'string') return /immediate/.test(g);
  return g === w;
}
/** Score a set of {expected, got} rows. Returns {n, fields: {k: correct}, critical, hallucinated, nullCells}. */
export function score(rows, fields = FIELDS) {
  const out = { n: rows.length, fields: Object.fromEntries(fields.map(f => [f, 0])), critical: 0, hallucinated: 0, nullCells: 0 };
  for (const { expected, got } of rows) {
    for (const f of fields) { if (same(f, got[f], expected[f])) out.fields[f]++; if (expected[f] == null) { out.nullCells++; if (got[f] != null && !(Array.isArray(got[f]) && !got[f].length)) out.hallucinated++; } }
    if (CRITICAL.every(f => same(f, got[f], expected[f]))) out.critical++;
  }
  return out;
}
export const rentals = posts => posts.filter(p => p.expected?.isRental !== false);
export function scoreRegex(posts, extractFn = extract) {
  return score(rentals(posts).map(p => ({ expected: p.expected, got: extractFn(p.text) })), FIELDS.filter(f => f !== 'availableFrom'));
}

async function cfRun(model, input) {
  const { CLOUDFLARE_ACCOUNT_ID: acct, CLOUDFLARE_API_TOKEN: tok } = process.env;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  return j.result;
}

async function online(posts, { model, batch }) {
  const ai = [], merged = []; let calls = 0, ms = 0, tokens = 0;
  for (let i = 0; i < posts.length; i += batch) {
    const chunk = posts.slice(i, i + batch).map(p => ({ p, text: redact(p.text), postedAt: Date.parse(p.postedAt) }));
    const t = Date.now();
    let res;
    try { res = await cfRun(model, { messages: [{ role: 'system', content: SYSTEM }, ...FEW_SHOT, { role: 'user', content: batchMessage(chunk) }], response_format: { type: 'json_schema', json_schema: SCHEMA }, max_tokens: 300 * chunk.length + 200, temperature: 0 }); }
    catch (e) { console.error(`batch ${i / batch + 1}: ${e.message}`); res = null; }
    ms += Date.now() - t; calls++; tokens += (res?.usage?.prompt_tokens || 0) + (res?.usage?.completion_tokens || 0);
    const parsed = parseOutput(res?.response ?? res?.choices?.[0]?.message?.content);
    const byId = new Map((parsed?.results || []).map(r => [String(r.id), r]));
    chunk.forEach(({ p, text, postedAt }, j) => {
      const v = validateResult(byId.get('P' + (j + 1)), text, postedAt);
      const regex = extract(p.text);
      const aiOnly = v ? { ...v.fields, bhk: v.fields.bhk, phones: regex.phones } : { phones: regex.phones };
      const l = { ...regex };
      if (v) mergeAi(l, v, { now: 0 });
      if (p.expected.isRental !== false) { ai.push({ expected: p.expected, got: aiOnly }); merged.push({ expected: p.expected, got: l }); }
    });
  }
  return { ai: score(ai), merged: score(merged), calls, avgMs: Math.round(ms / Math.max(1, calls)), tokens };
}

function table(cols) {
  const names = Object.keys(cols);
  console.log(['field'.padEnd(16), ...names.map(n => n.padStart(9))].join(''));
  for (const f of FIELDS) { if (names.every(n => cols[n].fields[f] === undefined)) continue; console.log([f.padEnd(16), ...names.map(n => String(cols[n].fields[f] ?? '-').padStart(9))].join('')); }
  console.log(['critical rows'.padEnd(16), ...names.map(n => String(cols[n].critical).padStart(9))].join(''));
  console.log(['hallucinated'.padEnd(16), ...names.map(n => `${cols[n].hallucinated}/${cols[n].nullCells}`.padStart(9))].join(''));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const data = JSON.parse(readFileSync(fileURLToPath(new URL('../test/fixtures/ai-eval-posts.json', import.meta.url)), 'utf8'));
  const posts = data.posts;
  const regex = scoreRegex(posts);
  console.log(`AI eval: ${rentals(posts).length} rental posts (+${posts.length - rentals(posts).length} non-rental)\n`);
  if (!args.online) { table({ regex }); console.log('\nOffline mode (regex only). Pass --online to run the model.'); process.exit(0); }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) { console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI: Read) for --online.'); process.exit(2); }
  const model = typeof args.model === 'string' ? args.model : MODELS.primary;
  const batch = Math.max(1, Math.min(10, parseInt(args.batch, 10) || 5));
  console.log(`model ${model}, batch ${batch}\n`);
  const r = await online(posts, { model, batch });
  table({ regex, ai: r.ai, merged: r.merged });
  console.log(`\n${r.calls} calls, ${r.avgMs} ms average, ${r.tokens} tokens`);
  const gate = FIELDS.filter(f => regex.fields[f] !== undefined).every(f => r.merged.fields[f] >= regex.fields[f]) && r.merged.critical >= Math.ceil(0.9 * regex.n) && r.merged.hallucinated <= 0.02 * r.merged.nullCells;
  console.log(`ship gate (merged >= regex on every field, critical >= 90 %, hallucination <= 2 %): ${gate ? 'PASS' : 'FAIL'}`);
  process.exit(gate ? 0 : 1);
}
