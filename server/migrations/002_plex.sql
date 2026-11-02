-- How you've decided to treat a show after reviewing it.
-- ignore_id_conflicts: you confirmed it's the same show despite a differing ID.
-- sonarr_only: don't use TVmaze for this show.
ALTER TABLE shows ADD COLUMN metadata_policy TEXT NOT NULL DEFAULT 'auto'
  CHECK (metadata_policy IN ('auto','ignore_id_conflicts','sonarr_only'));
-- You confirmed season/episode numbers line up even though air dates differ.
ALTER TABLE shows ADD COLUMN trust_numbering INTEGER NOT NULL DEFAULT 0;

-- External watches we couldn't confidently place. Kept so nothing is lost if the source
-- later drops the item; retried on each sync and assignable by hand.
CREATE TABLE unmatched_watches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  show_id INTEGER REFERENCES shows(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  occurred_at_utc TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','dismissed')),
  episode_id INTEGER REFERENCES episodes(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_key)
);
CREATE INDEX unmatched_status ON unmatched_watches(status);
