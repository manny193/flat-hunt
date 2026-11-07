#!/usr/bin/env node
// Fills the deploy-time placeholders in wrangler.jsonc so the founder never copies IDs by hand.
//
//   1. D1 database id: env D1_DATABASE_ID if set, else looked up by name with
//      `wrangler d1 list --json`; created (`wrangler d1 create`) when missing and CREATE_D1=1.
//   2. PUBLIC_BASE_URL: env PUBLIC_BASE_URL if set, else
//      https://<worker-name>.<account workers.dev subdomain>.workers.dev from the Cloudflare API.
//
// Writes `database_id` and `base_url` to $GITHUB_OUTPUT when running in Actions.
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unless both overrides are given.
// Usage: node .github/scripts/prepare-wrangler-config.mjs [path/to/wrangler.jsonc]
// Env: WRANGLER_VERSION (pin), CREATE_D1=1, RESOLVE_D1=0 (only resolve the URL).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
const configPath = process.argv[2] || 'wrangler.jsonc';
const wranglerVersion = process.env.WRANGLER_VERSION || '4';
const resolveD1 = process.env.RESOLVE_D1 !== '0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

let text = readFileSync(configPath, 'utf8');
const field = (key) => {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
};
const workerName = field('name');
const dbName = field('database_name');
if (!workerName || !dbName) fail(`Could not read "name" / "database_name" from ${configPath}`);

function wrangler(args) {
  return execFileSync('npx', ['--yes', `wrangler@${wranglerVersion}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
}

function parseJsonLoose(out) {
  // Wrangler may print a banner or "[WARNING]" line before the JSON payload:
  // try each line that starts with [ or { until one parses.
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[[{]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {}
  }
  throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`);
}

function findDbId() {
  const list = parseJsonLoose(wrangler(['d1', 'list', '--json']));
  const rows = Array.isArray(list) ? list : list.result || [];
  const row = rows.find((r) => r.name === dbName);
  return row ? row.uuid || row.id || row.database_id : undefined;
}

async function resolveBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) fail('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (or set PUBLIC_BASE_URL).');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  const sub = body?.result?.subdomain;
  if (!res.ok || !sub) {
    fail(
      `No workers.dev subdomain found for this account (HTTP ${res.status}). ` +
        'Open the Cloudflare dashboard > Workers & Pages once and pick a subdomain, ' +
        'or set the repository variable PUBLIC_BASE_URL.'
    );
  }
  return `https://${workerName}.${sub}.workers.dev`;
}

let dbId = process.env.D1_DATABASE_ID || '';
if (resolveD1) {
  if (dbId && !UUID.test(dbId)) fail('D1_DATABASE_ID is not a UUID.');
  if (!dbId) dbId = findDbId() || '';
  if (!dbId && process.env.CREATE_D1 === '1') {
    console.log(`Creating D1 database "${dbName}" (location hint: apac)...`);
    wrangler(['d1', 'create', dbName, '--location', 'apac']);
    dbId = findDbId() || '';
  }
  if (!dbId) fail(`D1 database "${dbName}" not found. Run the Deploy workflow (it creates it) or set D1_DATABASE_ID.`);
  text = text.replace(`"database_id": "${PLACEHOLDER_ID}"`, `"database_id": "${dbId}"`);
}

const baseUrl = await resolveBaseUrl();
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(baseUrl)) fail(`PUBLIC_BASE_URL must look like https://host, got "${baseUrl}"`);
text = text.replace(/"PUBLIC_BASE_URL"\s*:\s*""/, `"PUBLIC_BASE_URL": "${baseUrl}"`);

writeFileSync(configPath, text);
console.log(`Config ready: worker=${workerName} db=${dbName}${dbId ? ` (${dbId})` : ''} url=${baseUrl}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `database_id=${dbId}\nbase_url=${baseUrl}\n`);
}
