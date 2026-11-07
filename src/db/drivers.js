// Two storage drivers behind one tiny interface, so the repository's SQL is shared:
//   all(sql, params) -> rows[]      first(sql, params) -> row|null
//   run(sql, params) -> {changes}   batch([{sql, params}]) -> results[] (atomic)

const param = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
const params = p => (p || []).map(param);

/** Cloudflare D1 binding (env.DB). */
export function d1Driver(DB) {
  const stmt = (sql, p) => DB.prepare(sql).bind(...params(p));
  return {
    kind: 'd1',
    async all(sql, p) { return (await stmt(sql, p).all()).results || []; },
    async first(sql, p) { return (await stmt(sql, p).first()) ?? null; },
    async run(sql, p) { const r = await stmt(sql, p).run(); return { changes: r.meta?.changes ?? 0 }; },
    async batch(list) {
      if (!list.length) return [];
      const res = await DB.batch(list.map(s => stmt(s.sql, s.params)));
      return res.map(r => ({ changes: r.meta?.changes ?? 0, rows: r.results || [] }));
    },
  };
}

/** node:sqlite DatabaseSync. Statements are cached; batch runs in a transaction. */
export function sqliteDriver(db) {
  const cache = new Map();
  const prep = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); if (cache.size > 200) cache.clear(); cache.set(sql, s); } return s; };
  const plain = r => r ? { ...r } : r;
  const runOne = (sql, p) => { const r = prep(sql).run(...params(p)); return { changes: Number(r.changes) }; };
  return {
    kind: 'sqlite',
    db,
    async all(sql, p) { return prep(sql).all(...params(p)).map(plain); },
    async first(sql, p) { return plain(prep(sql).get(...params(p))) ?? null; },
    async run(sql, p) { return runOne(sql, p); },
    async batch(list) {
      if (!list.length) return [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = list.map(s => /^\s*(select|with)\b/i.test(s.sql) && !/\b(insert|update|delete)\b/i.test(s.sql)
          ? { changes: 0, rows: prep(s.sql).all(...params(s.params)).map(plain) }
          : runOne(s.sql, s.params));
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

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
