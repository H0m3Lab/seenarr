-- Watch history is the source of truth. No row in shows, episodes or watch_events is ever
-- deleted by a sync; foreign keys are RESTRICT so a bug can't cascade history away.

CREATE TABLE shows (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  sort_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Unknown' CHECK (status IN ('Returning','Ended','Canceled','Upcoming','Unknown')),
  provider_status TEXT,
  overview TEXT,
  network TEXT,
  premiere_date TEXT,
  poster_url TEXT,
  poster_file TEXT,
  tracking_state TEXT NOT NULL CHECK (tracking_state IN ('discovered','following','archived')),
  metadata_state TEXT NOT NULL DEFAULT 'pending' CHECK (metadata_state IN ('pending','ok','not_found','error','needs_review')),
  metadata_version INTEGER,
  metadata_refreshed_at TEXT,
  in_sonarr INTEGER NOT NULL DEFAULT 0,
  sonarr_monitored INTEGER NOT NULL DEFAULT 0,
  sonarr_removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX shows_tracking ON shows(tracking_state);

-- Identity is external IDs, never titles.
CREATE TABLE show_ids (
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('tvmaze','tvdb','imdb','tmdb','tvrage','sonarr','plex','trakt')),
  external_id TEXT NOT NULL,
  PRIMARY KEY (provider, external_id),
  UNIQUE (show_id, provider)
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  season INTEGER NOT NULL,
  number INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('regular','special')),
  title TEXT,
  overview TEXT,
  air_at_utc TEXT,
  air_date TEXT,
  runtime INTEGER,
  orphaned INTEGER NOT NULL DEFAULT 0, -- gone from the provider; kept forever
  has_file INTEGER NOT NULL DEFAULT 0,
  in_plex INTEGER NOT NULL DEFAULT 0,
  sonarr_monitored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX episodes_number ON episodes(show_id, season, number) WHERE number IS NOT NULL AND orphaned = 0;
CREATE INDEX episodes_show ON episodes(show_id);

CREATE TABLE episode_ids (
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (provider, external_id),
  UNIQUE (episode_id, provider)
);

-- Sonarr's current view, replaced on each sync. Not history: availability only.
CREATE TABLE sonarr_episodes (
  sonarr_id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  season INTEGER NOT NULL,
  number INTEGER NOT NULL,
  tvdb_id TEXT,
  has_file INTEGER NOT NULL,
  monitored INTEGER NOT NULL,
  title TEXT,
  overview TEXT,
  air_at_utc TEXT,
  air_date TEXT
);
CREATE INDEX sonarr_episodes_show ON sonarr_episodes(show_id);

-- Append-only log. Watched/unwatched state is always derived from it.
-- occurred_at_utc: when it happened (NULL = unknown date).
-- precedence_at: decides which event wins. Manual events use the moment you acted, so a
-- backdated manual watch still beats an earlier unwatch. External events use their own
-- viewed time ('' when unknown), so re-reading an old record can never undo a manual unwatch.
CREATE TABLE watch_events (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('watched','unwatched')),
  source TEXT NOT NULL CHECK (source IN ('manual','plex','trakt')),
  occurred_at_utc TEXT,
  date_quality TEXT NOT NULL CHECK (date_quality IN ('exact','date_only','unknown')),
  precedence_at TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  raw_ref TEXT NOT NULL,
  duplicate_of INTEGER REFERENCES watch_events(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL,
  UNIQUE (source, source_event_key)
);
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

CREATE TABLE review_queue (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  show_id INTEGER REFERENCES shows(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','closed_auto')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  summary TEXT,
  error TEXT
);
CREATE INDEX sync_runs_source ON sync_runs(source, id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
