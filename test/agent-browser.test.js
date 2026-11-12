// Agent browser wrapper (scripts/agent-browser/mcp.sh): every Claude session
// must get its own throwaway Chrome profile, copied from the seed profile, and
// must never write anything but MCP traffic to stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'agent-browser', 'mcp.sh');

// A fake `npx` that records its args and what the profile looked like while
// the "browser" was running.
const FAKE_NPX = `#!/bin/sh
prof=""; prev=""
for a in "$@"; do [ "$prev" = "--user-data-dir" ] && prof="$a"; prev="$a"; done
{
  printf 'arg:%s\\n' "$@"
  [ -f "$prof/Default/Cookies" ] && echo has-cookies
  [ -e "$prof/SingletonLock" ] || [ -L "$prof/SingletonLock" ] && echo has-lock
  [ -e "$prof/Default/Cache" ] && echo has-cache
  echo "profile:$prof"
} > "$FAKE_LOG.$$"
mv "$FAKE_LOG.$$" "$FAKE_LOG"
[ -n "\${FAKE_SLEEP:-}" ] && sleep "$FAKE_SLEEP"
exit 0
`;

function setup({ seed = true, locked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-browser-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), FAKE_NPX);
  chmodSync(join(bin, 'npx'), 0o755);
  const home = join(root, 'home');
  if (seed) {
    const s = join(home, 'seed-profile');
    mkdirSync(join(s, 'Default', 'Cache'), { recursive: true });
    writeFileSync(join(s, 'Default', 'Cookies'), 'cookie-db');
    writeFileSync(join(s, 'Default', 'Cache', 'blob'), 'x');
    if (locked) symlinkSync('host-123', join(s, 'SingletonLock'));
  }
  return { root, home, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_BROWSER_HOME: home } };
}

function parse(logFile) {
  const text = readFileSync(logFile, 'utf8');
  const lines = text.trim().split('\n');
  return {
    args: lines.filter((l) => l.startsWith('arg:')).map((l) => l.slice(4)),
    flags: new Set(lines.filter((l) => l.startsWith('has-'))),
    profile: lines.find((l) => l.startsWith('profile:')).slice(8),
  };
}

test('copies the seed into a private profile, skips locks and caches, deletes it on exit', () => {
  const { root, home, env } = setup();
  const log = join(root, 'run.log');
  const r = spawnSync('sh', [SCRIPT], { env: { ...env, FAKE_LOG: log }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'stdout is reserved for MCP traffic');
  const { args, flags, profile } = parse(log);
  assert.ok(args.some((a) => a.startsWith('@playwright/mcp@')));
  assert.ok(args.includes('--user-data-dir'));
  assert.ok(profile.startsWith(join(home, 'sessions')), profile);
  assert.ok(flags.has('has-cookies'), 'logins come from the seed');
  assert.ok(!flags.has('has-lock'), 'Chrome lock files are not copied');
  assert.ok(!flags.has('has-cache'), 'caches are not copied');
  assert.ok(!existsSync(profile), 'session profile is removed on exit');
  assert.ok(existsSync(join(dirname(profile), 'output')), 'screenshots dir is kept');
  assert.ok(existsSync(join(home, 'seed-profile', 'Default', 'Cookies')), 'seed is untouched');
});

test('two concurrent sessions get different profiles', async () => {
  const { root, env } = setup();
  const run = (n) => new Promise((resolve) => {
    const log = join(root, `run${n}.log`);
    const p = spawn('sh', [SCRIPT], { env: { ...env, FAKE_LOG: log, FAKE_SLEEP: '0.5' } });
    p.on('exit', (code) => resolve({ code, log }));
  });
  const [a, b] = await Promise.all([run(1), run(2)]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.notEqual(parse(a.log).profile, parse(b.log).profile);
});

test('refuses to reuse an existing session id', () => {
  const { root, env } = setup();
  const e = { ...env, FAKE_LOG: join(root, 'x.log'), AGENT_BROWSER_SESSION_ID: 'fixed' };
  assert.equal(spawnSync('sh', [SCRIPT], { env: e }).status, 0);
  const r = spawnSync('sh', [SCRIPT], { env: e, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to share/);
});

test('seed open in Chrome or missing: starts signed out with a warning on stderr', () => {
  for (const opts of [{ locked: true }, { seed: false }]) {
    const { root, home, env } = setup(opts);
    const log = join(root, 'run.log');
    const r = spawnSync('sh', [SCRIPT], { env: { ...env, FAKE_LOG: log }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /signed out/);
    assert.ok(!parse(log).flags.has('has-cookies'));
    assert.equal(readdirSync(join(home, 'sessions')).length, 1);
  }
});
