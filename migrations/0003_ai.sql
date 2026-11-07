-- Flat Hunt 0003: AI extraction queue and merge suggestions (docs/AI-EXTRACTION.md). Add-only.

-- One row per post to read with the model. post_id = data.posts[].id of the listing's newest post.
CREATE TABLE IF NOT EXISTS ai_queue (
  post_id    TEXT    PRIMARY KEY,
  listing_id TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending', -- pending | retry | done | failed | skipped
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  model      TEXT,
  confidence REAL,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_queue_due ON ai_queue (status, next_at);
CREATE INDEX IF NOT EXISTS ai_queue_listing ON ai_queue (listing_id);

-- When AI corrections make two listings look identical but the auto-merge rule (same phone, same BHK,
-- rent within 2 %) does not hold, an admin decides on #admin-ai.
CREATE TABLE IF NOT EXISTS merge_suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  a          TEXT    NOT NULL,
  b          TEXT    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'open', -- open | merged | dismissed
  created_at INTEGER NOT NULL,
  UNIQUE (a, b)
);
CREATE INDEX IF NOT EXISTS merge_suggestions_status ON merge_suggestions (status, created_at DESC);
