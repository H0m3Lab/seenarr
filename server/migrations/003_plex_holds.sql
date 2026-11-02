-- Plex shows matched to the wrong show in Plex itself. Their episode IDs can't be trusted,
-- so nothing from them is recorded automatically; plays wait for assignment by hand.
CREATE TABLE plex_holds (
  plex_guid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO plex_holds (plex_guid, title, reason, created_at) VALUES
  ('plex://show/5d9c080c2192ba001f305de0', 'The Blacklist: Redemption', 'Plex lists The Blacklist episodes under this show', '2026-11-02T00:00:00.000Z'),
  ('plex://show/5d9c084ce98e47001eb0c0b7', 'Marvel''s Agent Carter', 'Plex lists Agents of S.H.I.E.L.D. episodes under this show', '2026-11-02T00:00:00.000Z');
