-- Shows deleted by hand from the web app. The snapshot holds everything that was removed
-- (show, IDs, episodes, watch history, review items) as JSON, so a mistake can be undone.
CREATE TABLE deleted_shows (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);

-- IDs of deleted shows. Syncs (Sonarr, Plex, later Trakt) never re-create a show with one of
-- these; adding the show again by hand through Add Show clears them.
CREATE TABLE deleted_show_ids (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  deleted_show_id INTEGER NOT NULL REFERENCES deleted_shows(id) ON DELETE RESTRICT,
  PRIMARY KEY (provider, external_id)
);
