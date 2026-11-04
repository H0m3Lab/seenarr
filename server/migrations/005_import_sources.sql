-- Allow watches imported from streaming-service history files (Prime Video now, Netflix later).
-- SQLite can't change a CHECK constraint in place, so the table is rebuilt with identical
-- rows and ids. Foreign keys are checked at commit, after the new table has its final name.
PRAGMA defer_foreign_keys = ON;

DROP VIEW episode_state;

CREATE TABLE watch_events_new (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('watched','unwatched')),
  source TEXT NOT NULL CHECK (source IN ('manual','plex','trakt','prime','netflix')),
  occurred_at_utc TEXT,
  date_quality TEXT NOT NULL CHECK (date_quality IN ('exact','date_only','unknown')),
  precedence_at TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  raw_ref TEXT NOT NULL,
  -- Points at itself; the rename below updates this to watch_events.
  duplicate_of INTEGER REFERENCES watch_events_new(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL,
  UNIQUE (source, source_event_key)
);

INSERT INTO watch_events_new (id, episode_id, kind, source, occurred_at_utc, date_quality, precedence_at, source_event_key, raw_ref, duplicate_of, recorded_at)
  SELECT id, episode_id, kind, source, occurred_at_utc, date_quality, precedence_at, source_event_key, raw_ref, duplicate_of, recorded_at FROM watch_events;

DROP TABLE watch_events;
ALTER TABLE watch_events_new RENAME TO watch_events;
CREATE INDEX watch_events_episode ON watch_events(episode_id);

CREATE VIEW episode_state AS
SELECT episode_id, kind AS state, occurred_at_utc, date_quality, source, id AS event_id
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY episode_id
    ORDER BY precedence_at DESC, CASE WHEN source = 'manual' THEN 1 ELSE 0 END DESC, id DESC
  ) AS rn
  FROM watch_events
) WHERE rn = 1;
