import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../db.js';

interface EpisodeRef {
  id: number;
  show_id: number;
  season: number;
  number: number | null;
  title: string | null;
  state: string | null;
  event_id: number | null;
}

const getEpisode = db.prepare(`
  SELECT e.id, e.show_id, e.season, e.number, e.title, st.state, st.event_id
  FROM episodes e LEFT JOIN episode_state st ON st.episode_id = e.id
  WHERE e.id = ?`);

const insertEvent = db.prepare(`
  INSERT INTO watch_events (episode_id, kind, source, occurred_at_utc, date_quality, precedence_at, source_event_key, raw_ref, recorded_at)
  VALUES (@episode_id, @kind, 'manual', @occurred, @quality, @at, @key, @raw, @at)`);

const SAME_WATCH_WINDOW_MS = 6 * 3600000;

export interface ExternalWatch {
  episodeId: number;
  source: 'plex' | 'trakt' | 'prime' | 'netflix';
  key: string; // stable per watch, so repeat imports add nothing
  occurredAt: string | null;
  raw: unknown;
  /** History files often give only the day; default is 'exact' when a time is given. */
  dateQuality?: 'exact' | 'date_only';
}

/**
 * Add a watch from an outside source. Returns false if it was already recorded. Its rank is
 * its own viewed time, so re-reading an old record can't undo a later manual unwatch. A watch
 * within 6 hours of another on the same episode is kept but counted as the same one.
 */
export function addExternalWatch(w: ExternalWatch): boolean {
  const info = db.prepare(`INSERT OR IGNORE INTO watch_events
      (episode_id, kind, source, occurred_at_utc, date_quality, precedence_at, source_event_key, raw_ref, recorded_at)
      VALUES (?, 'watched', ?, ?, ?, ?, ?, ?, ?)`)
    .run(w.episodeId, w.source, w.occurredAt, w.occurredAt ? (w.dateQuality ?? 'exact') : 'unknown', w.occurredAt ?? '', w.key, JSON.stringify(w.raw), nowIso());
  if (!info.changes) return false;
  if (w.occurredAt) {
    const t = Date.parse(w.occurredAt);
    const near = db.prepare(`SELECT id FROM watch_events WHERE episode_id = ? AND kind = 'watched' AND id != ? AND duplicate_of IS NULL
        AND occurred_at_utc BETWEEN ? AND ? ORDER BY occurred_at_utc LIMIT 1`).pluck()
      .get(w.episodeId, info.lastInsertRowid, new Date(t - SAME_WATCH_WINDOW_MS).toISOString(), new Date(t + SAME_WATCH_WINDOW_MS).toISOString()) as number | undefined;
    if (near !== undefined) db.prepare('UPDATE watch_events SET duplicate_of = ? WHERE id = ?').run(near, info.lastInsertRowid);
  }
  // Watching a discovered show means you follow it. Archived stays archived.
  db.prepare(`UPDATE shows SET tracking_state = 'following', updated_at = ?
    WHERE tracking_state = 'discovered' AND id = (SELECT show_id FROM episodes WHERE id = ?)`).run(nowIso(), w.episodeId);
  return true;
}

export type WatchDate ={ mode: 'now' } | { mode: 'unknown' } | { mode: 'date'; at: string };

/**
 * Record a manual watched/unwatched for episodes. Episodes already in the requested state
 * are skipped, so bulk actions add no duplicates. Returns how many changed.
 */
export function setWatched(episodeIds: number[], watched: boolean, date: WatchDate = { mode: 'now' }): number {
  return db.transaction(() => {
    let changed = 0;
    for (const id of episodeIds) {
      const ep = getEpisode.get(id) as EpisodeRef | undefined;
      if (!ep) continue;
      if ((ep.state === 'watched') === watched) continue;
      const at = nowIso();
      const occurred = !watched || date.mode === 'now' ? at : date.mode === 'date' ? date.at : null;
      insertEvent.run({
        episode_id: id,
        kind: watched ? 'watched' : 'unwatched',
        occurred,
        quality: occurred === null ? 'unknown' : !watched || date.mode === 'now' ? 'exact' : 'date_only',
        at,
        key: randomUUID(),
        raw: JSON.stringify({ show_id: ep.show_id, season: ep.season, number: ep.number, title: ep.title }),
      });
      changed++;
    }
    return changed;
  })();
}

/**
 * Correct the date on a watched episode. A new event carries the date and the old one is
 * kept but marked as a duplicate of it, so it is one watch rather than two.
 */
export function correctWatchDate(episodeId: number, at: string | null): boolean {
  return db.transaction(() => {
    const ep = getEpisode.get(episodeId) as EpisodeRef | undefined;
    if (!ep || ep.state !== 'watched' || ep.event_id === null) return false;
    const now = nowIso();
    const info = insertEvent.run({
      episode_id: episodeId,
      kind: 'watched',
      occurred: at,
      quality: at === null ? 'unknown' : 'date_only',
      at: now,
      key: randomUUID(),
      raw: JSON.stringify({ show_id: ep.show_id, season: ep.season, number: ep.number, title: ep.title, corrects: ep.event_id }),
    });
    db.prepare('UPDATE watch_events SET duplicate_of = ? WHERE id = ?').run(info.lastInsertRowid, ep.event_id);
    return true;
  })();
}
