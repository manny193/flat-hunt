-- Flat Hunt 0004: area alerts over Web Push (docs/ai/ALERTS-WEBPUSH.md). Add-only: old code ignores
-- these tables, so a code rollback is safe. No BEGIN/COMMIT, no virtual tables.

-- Where a user can be reached. One row per device (web push) or chat (telegram, later).
-- address = push endpoint URL (web push). Personal data and a capability: never log or return it.
CREATE TABLE IF NOT EXISTS alert_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  channel     TEXT    NOT NULL,                 -- 'webpush' (v1) | 'telegram' (later)
  address     TEXT    NOT NULL,
  keys        TEXT    NOT NULL DEFAULT '{}',    -- web push {p256dh, auth}; kept for a future encrypted payload, unused in v1
  label       TEXT    NOT NULL DEFAULT '',      -- coarse device label from the client, e.g. 'Android · Chrome'
  failures    INTEGER NOT NULL DEFAULT 0,
  last_ok_at  INTEGER,
  last_error  TEXT,                             -- short code, e.g. 'http_403', never the endpoint
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (channel, address)
);
CREATE INDEX IF NOT EXISTS alert_targets_user ON alert_targets (user_id);

-- Per-user alert settings. No row = alerts never set up.
CREATE TABLE IF NOT EXISTS alert_prefs (
  user_id        INTEGER PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 1,
  quiet_start    INTEGER NOT NULL DEFAULT 22,   -- IST hour 0-23; quiet from quiet_start to quiet_end
  quiet_end      INTEGER NOT NULL DEFAULT 8,    -- equal start and end = no quiet hours
  max_listings   INTEGER NOT NULL DEFAULT 30,   -- listings per IST day (1-50)
  max_digests    INTEGER NOT NULL DEFAULT 6,    -- digests per IST day (1-12)
  min_gap_min    INTEGER NOT NULL DEFAULT 60,   -- minutes between digests (30-720)
  test_at        INTEGER,                       -- last test send (inbox shows the test text for 10 min)
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Which followed areas alert, with optional cheap filters (matched against listing_match columns).
CREATE TABLE IF NOT EXISTS alert_areas (
  user_id    INTEGER NOT NULL,
  area_id    INTEGER NOT NULL,
  max_rent   INTEGER,                           -- NULL = any; listings with unknown rent are included
  bhks       TEXT    NOT NULL DEFAULT '',       -- '' = any, else ',1,2,1RK,' (bhkKey values, comma-wrapped)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, area_id)
);
CREATE INDEX IF NOT EXISTS alert_areas_area ON alert_areas (area_id);

-- Queue and dedupe log in one: one row per (user, listing). sent_at doubles as the batch id.
CREATE TABLE IF NOT EXISTS alert_queue (
  user_id    INTEGER NOT NULL,
  listing_id TEXT    NOT NULL,
  area_id    INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending', -- pending | sent | capped | expired
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS alert_queue_pending ON alert_queue (status, user_id, created_at);
CREATE INDEX IF NOT EXISTS alert_queue_user_sent ON alert_queue (user_id, sent_at DESC);
