import { db, nowIso } from '../db.js';

const IN_SHOW_EPISODES = 'SELECT id FROM episodes WHERE show_id = ?';

/**
 * Delete one show by hand. Only the web app's Delete button calls this; no sync or job does.
 * Everything removed is kept as one JSON snapshot in deleted_shows, and the show's IDs are
 * remembered so Sonarr/Plex syncs can't bring it back. Adding it again through Add Show can.
 */
export function deleteShow(showId: number): { title: string; episodes: number; watchEvents: number } | null {
  return db.transaction(() => {
    const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId) as { title: string } | undefined;
    if (!show) return null;
    const all = (sql: string) => db.prepare(sql).all(showId);
    const snapshot = {
      show,
      showIds: all('SELECT * FROM show_ids WHERE show_id = ?'),
      episodes: all('SELECT * FROM episodes WHERE show_id = ?'),
      episodeIds: all(`SELECT * FROM episode_ids WHERE episode_id IN (${IN_SHOW_EPISODES})`),
      watchEvents: all(`SELECT * FROM watch_events WHERE episode_id IN (${IN_SHOW_EPISODES}) ORDER BY id`),
      sonarrEpisodes: all('SELECT * FROM sonarr_episodes WHERE show_id = ?'),
      reviewItems: all('SELECT * FROM review_queue WHERE show_id = ?'),
      unmatchedWatches: db.prepare(`SELECT * FROM unmatched_watches WHERE show_id = ? OR episode_id IN (${IN_SHOW_EPISODES})`).all(showId, showId),
    };
    const deletedId = Number(db.prepare('INSERT INTO deleted_shows (title, deleted_at, snapshot) VALUES (?, ?, ?)')
      .run(show.title, nowIso(), JSON.stringify(snapshot)).lastInsertRowid);
    const remember = db.prepare('INSERT OR REPLACE INTO deleted_show_ids (provider, external_id, deleted_show_id) VALUES (?, ?, ?)');
    for (const r of snapshot.showIds as { provider: string; external_id: string }[]) remember.run(r.provider, r.external_id, deletedId);

    const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
    run(`UPDATE watch_events SET duplicate_of = NULL WHERE episode_id IN (${IN_SHOW_EPISODES})`, showId);
    run(`DELETE FROM watch_events WHERE episode_id IN (${IN_SHOW_EPISODES})`, showId);
    run(`DELETE FROM unmatched_watches WHERE show_id = ? OR episode_id IN (${IN_SHOW_EPISODES})`, showId, showId);
    run('DELETE FROM review_queue WHERE show_id = ?', showId);
    run(`DELETE FROM episode_ids WHERE episode_id IN (${IN_SHOW_EPISODES})`, showId);
    run('DELETE FROM sonarr_episodes WHERE show_id = ?', showId);
    run('DELETE FROM episodes WHERE show_id = ?', showId);
    run('DELETE FROM show_ids WHERE show_id = ?', showId);
    run('DELETE FROM shows WHERE id = ?', showId);
    return { title: show.title, episodes: snapshot.episodes.length, watchEvents: snapshot.watchEvents.length };
  })();
}
