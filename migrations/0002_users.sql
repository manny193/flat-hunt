-- Flat Hunt 0002: accounts, per-user review state, per-user areas, public rate limit, AI columns,
-- per-run stats columns. Add-only (new tables/columns), so the previous code version keeps working
-- after a code rollback. No BEGIN/COMMIT (D1 wraps each migration file itself).

-- Accounts. Google sign-in creates rows; role 'admin' also comes from the ADMIN_EMAILS env var.
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT    NOT NULL DEFAULT '',
  picture      TEXT    NOT NULL DEFAULT '',
  role         TEXT    NOT NULL DEFAULT 'user'   CHECK (role IN ('admin','user')),
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','blocked')),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- A user's own decision on a shared listing. No row = not reviewed yet ('new').
CREATE TABLE IF NOT EXISTS user_listing (
  user_id    INTEGER NOT NULL,
  listing_id TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','rejected')),
  stage      TEXT    NOT NULL DEFAULT '',
  notes      TEXT    NOT NULL DEFAULT '',
  has_update INTEGER NOT NULL DEFAULT 0,
  decided_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS user_listing_listing ON user_listing (listing_id, status);

-- Areas a user hunts in (areas themselves are global and scanned for everyone).
CREATE TABLE IF NOT EXISTS user_areas (
  user_id    INTEGER NOT NULL,
  area_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, area_id)
);
CREATE INDEX IF NOT EXISTS user_areas_area ON user_areas (area_id);

-- Fixed-window request counters for the public API (key = 'pub:<ip>'). Purged daily.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- AI extraction hook (src/ai.js): '' = not attempted, else 'done' | 'failed' | 'skipped'.
ALTER TABLE listings ADD COLUMN ai_status TEXT NOT NULL DEFAULT '';
ALTER TABLE listings ADD COLUMN ai_confidence REAL;

-- Per-run facts for the admin run log (the counts themselves live in runs.report).
ALTER TABLE runs ADD COLUMN actor TEXT;
ALTER TABLE runs ADD COLUMN cost_usd REAL;
ALTER TABLE runs ADD COLUMN finished_at INTEGER;
CREATE INDEX IF NOT EXISTS runs_source_at ON runs (source, at DESC);

-- Every housing post is now stored and matched to areas on read: listing_match is the listing<->area
-- join table (area_id 0 = no area yet). This index makes "newest listings in area X" a range scan.
CREATE INDEX IF NOT EXISTS listing_match_area_posted ON listing_match (area_id, last_posted_at DESC);
