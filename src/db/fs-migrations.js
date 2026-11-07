// Node only: read migrations/*.sql from disk.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
export function loadMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter(f => /^\d+.*\.sql$/.test(f)).sort().map(name => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}
