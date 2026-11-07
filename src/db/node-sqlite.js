// Node only (never imported by the Worker bundle): open node:sqlite and apply migrations.

/** Open a node:sqlite database file (or ':memory:'), with sensible pragmas. */
export async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * Apply migrations in name order. Uses the same bookkeeping table as `wrangler d1 migrations apply`,
 * so a database can move between the two without re-running anything.
 * migrations: [{name, sql}]
 */
export function migrateSqlite(db, migrations) {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  const done = new Set(db.prepare('SELECT name FROM d1_migrations').all().map(r => r.name));
  const applied = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    db.exec('BEGIN');
    try { db.exec(m.sql); db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(m.name); db.exec('COMMIT'); applied.push(m.name); }
    catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${m.name} failed: ${e.message}`); }
  }
  return applied;
}
