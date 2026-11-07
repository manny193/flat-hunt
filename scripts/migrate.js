// Apply migrations to the local node:sqlite database (DB_PATH, default ./data/flat-hunt.db).
// On Cloudflare D1 use `wrangler d1 migrations apply` instead (same bookkeeping table).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openSqlite, migrateSqlite } from '../src/db/node-sqlite.js';
import { loadMigrations } from '../src/db/fs-migrations.js';

const path = process.env.DB_PATH || './data/flat-hunt.db';
mkdirSync(dirname(resolve(path)), { recursive: true });
const db = await openSqlite(path);
const applied = migrateSqlite(db, loadMigrations());
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date.');
db.close();
