// Shared test helpers: in-memory node:sqlite with migrations applied.
import { readFileSync } from 'node:fs';
import { sqliteDriver } from '../src/db/drivers.js';
import { openSqlite, migrateSqlite } from '../src/db/node-sqlite.js';
import { loadMigrations } from '../src/db/fs-migrations.js';
import { createRepo } from '../src/db/repo.js';

export async function memoryDb() {
  const raw = await openSqlite(':memory:');
  migrateSqlite(raw, loadMigrations());
  const db = sqliteDriver(raw);
  return { raw, db, repo: createRepo(db) };
}
export const SAMPLES = JSON.parse(readFileSync(new URL('../web/samples.json', import.meta.url), 'utf8'));
export const GREEN_GLEN = { name: 'Green Glen', keywords: ['green glen', 'greenglen', 'green glenn', 'green glen layout'], active: true };
