-- Flat Hunt 0005: place lookup for posts whose text names no area we know, only a society or a map link
-- (src/locate.js, docs/AI-EXTRACTION.md "Where is the flat"). Add-only: old code ignores both tables.

-- One row per listing waiting for a lookup. Filled by the AI enrich pass, drained by the cron.
CREATE TABLE IF NOT EXISTS loc_queue (
  listing_id TEXT    PRIMARY KEY,
  status     TEXT    NOT NULL DEFAULT 'pending', -- pending | retry | done | none | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS loc_queue_due ON loc_queue (status, next_at);

-- Cache of society look-ups, so one society is asked for once. key = normalised society name.
-- text = address parts (road, neighbourhood, suburb ...) that area keywords are matched against; '' = not found.
CREATE TABLE IF NOT EXISTS places (
  key  TEXT    PRIMARY KEY,
  text TEXT    NOT NULL DEFAULT '',
  lat  REAL,
  lon  REAL,
  at   INTEGER NOT NULL
);
