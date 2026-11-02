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

export type WatchDate = { mode: 'now' } | { mode: 'unknown' } | { mode: 'date'; at: string };

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
