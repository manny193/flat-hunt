-- Flat Radar schema (SQLite dialect: runs on Cloudflare D1 and node:sqlite).
-- Times are epoch milliseconds (INTEGER). JSON is stored as TEXT.

-- Areas the user is hunting in. keywords = JSON array of lowercase variants.
CREATE TABLE IF NOT EXISTS areas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  keywords   TEXT    NOT NULL DEFAULT '[]',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- One row per distinct flat/room. Columns hold what we query or what the user owns
-- (status, stage, notes); everything extracted from posts lives in data (JSON).
CREATE TABLE IF NOT EXISTS listings (
  id              TEXT    PRIMARY KEY,
  status          TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','rejected')),
  stage           TEXT    NOT NULL DEFAULT '',
  notes           TEXT    NOT NULL DEFAULT '',
  kind            TEXT    NOT NULL DEFAULT 'offer',
  bhk             TEXT,
  rent            INTEGER,
  has_update      INTEGER NOT NULL DEFAULT 0,
  is_sample       INTEGER NOT NULL DEFAULT 0,
  areas           TEXT    NOT NULL DEFAULT '[]',
  phones          TEXT    NOT NULL DEFAULT '[]',
  fp              TEXT    NOT NULL DEFAULT '[]',
  first_posted_at INTEGER,
  last_posted_at  INTEGER NOT NULL,
  decided_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  data            TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS listings_status_posted ON listings (status, last_posted_at DESC);
CREATE INDEX IF NOT EXISTS listings_posted ON listings (last_posted_at DESC);
CREATE INDEX IF NOT EXISTS listings_updated ON listings (updated_at);

-- Fuzzy-match index: one row per (listing, area). area_id 0 = matched no area.
-- Lets ingest pull a small candidate set (same area + kind, rent window) with an index range scan.
CREATE TABLE IF NOT EXISTS listing_match (
  listing_id     TEXT    NOT NULL,
  area_id        INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  bhk            TEXT,
  rent           INTEGER,
  last_posted_at INTEGER NOT NULL,
  PRIMARY KEY (listing_id, area_id)
);
CREATE INDEX IF NOT EXISTS listing_match_lookup ON listing_match (area_id, kind, rent);
CREATE INDEX IF NOT EXISTS listing_match_recent ON listing_match (area_id, kind, last_posted_at);

-- Exact-duplicate keys: 'u:<normalised url>', 'h:<text hash>', 'n:<text hash>|<group>' (url-less posts).
CREATE TABLE IF NOT EXISTS post_keys (
  key        TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS post_keys_listing ON post_keys (listing_id);

-- Import / Apify run log. dataset_id is UNIQUE so a dataset is ingested once.
-- status: running (we started it on Apify) | ingesting | done | failed
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT    NOT NULL,
  dataset_id TEXT    UNIQUE,
  run_id     TEXT,
  status     TEXT    NOT NULL DEFAULT 'done',
  started_at INTEGER,
  at         INTEGER NOT NULL,
  report     TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS runs_at ON runs (at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Failed password logins per client IP (shared across Worker isolates).
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT    PRIMARY KEY,
  fails        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
