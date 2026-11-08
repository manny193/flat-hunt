import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PUBLIC_ASSETS } from '../src/app.js';

test('every module imported by web/*.js is a public asset (a missing one blanks the whole UI)', () => {
  const dir = new URL('../web/', import.meta.url);
  const missing = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      const path = '/' + new URL(spec, 'http://x/' + f).pathname.replace(/^\/+/, '');
      if (!PUBLIC_ASSETS.has(path)) missing.push(`${f} imports ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});
