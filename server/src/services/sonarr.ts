import { config } from '../config.js';
import { db, nowIso, toUtc } from '../db.js';
import { fetchRetry, HttpError } from '../http.js';
import { addShowIds, closeReview, createShow, findShowsByIds, isDeletedShow, openReview, type IdSet } from './identity.js';
import { linkSonarr } from './link.js';

interface SonarrSeries {
  id: number;
  title: string;
  tvdbId?: number;
  tvMazeId?: number;
  tmdbId?: number;
  imdbId?: string;
  tvRageId?: number;
  monitored?: boolean;
}

interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  tvdbId?: number;
  hasFile?: boolean;
  monitored?: boolean;
  title?: string;
  overview?: string;
  airDate?: string;
  airDateUtc?: string;
}

async function get<T>(path: string): Promise<T> {
  if (!config.sonarrUrl || !config.sonarrKey) throw new Error('Sonarr is not configured');
  const url = `${config.sonarrUrl}/api/v3${path}`;
  const res = await fetchRetry(url, { headers: { 'X-Api-Key': config.sonarrKey } });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

export async function testSonarr(): Promise<string> {
  const status = await get<{ version: string }>('/system/status');
  return `Connected, Sonarr ${status.version}`;
}

const seriesIds = (s: SonarrSeries): IdSet => ({
  sonarr: s.id,
  tvdb: s.tvdbId,
  tvmaze: s.tvMazeId,
  tmdb: s.tmdbId,
  imdb: s.imdbId,
  tvrage: s.tvRageId,
});

/**
 * Read-only import. New series arrive as 'discovered'. A series gone from Sonarr keeps its
 * show, episodes and history here, and only loses its availability.
 */
export async function syncSonarr() {
  const series = await get<SonarrSeries[]>('/series');
  const previouslyIn = db.prepare('SELECT COUNT(*) FROM shows WHERE in_sonarr = 1').pluck().get() as number;
  if (series.length === 0 && previouslyIn > 0) {
    // An empty list from a working Sonarr is far more likely a fault than a real wipe.
    throw new Error(`Sonarr returned no series but ${previouslyIn} were known; changing nothing`);
  }

  const seen = new Set<number>();
  let added = 0;
  let conflicts = 0;
  for (const s of series) {
    const episodes = await get<SonarrEpisode[]>(`/episode?seriesId=${s.id}`);
    const showId = db.transaction(() => {
      const ids = seriesIds(s);
      const matches = findShowsByIds(ids);
      const key = `sonarr_conflict:${s.id}`;
      if (matches.length > 1) {
        openReview(key, 'show_id_conflict', matches[0], `Sonarr's "${s.title}" matches ${matches.length} different shows`, { sonarrSeries: s.id, matches, ids });
        conflicts++;
        return null;
      }
      let id = matches[0];
      if (id === undefined) {
        if (isDeletedShow(ids)) return null; // you deleted it here; Sonarr can't bring it back
        id = createShow(s.title, 'discovered');
        added++;
      }
      const policy = db.prepare('SELECT metadata_policy FROM shows WHERE id = ?').pluck().get(id) as string;
      const problems = addShowIds(id, ids, policy !== 'auto');
      if (problems.length) {
        openReview(key, 'show_id_conflict', id, `Sonarr's IDs for "${s.title}" disagree`, { problems });
        conflicts++;
      } else {
        closeReview(key);
      }
      db.prepare('UPDATE shows SET in_sonarr = 1, sonarr_monitored = ?, sonarr_removed_at = NULL, updated_at = ? WHERE id = ?')
        .run(s.monitored ? 1 : 0, nowIso(), id);
      db.prepare('DELETE FROM sonarr_episodes WHERE show_id = ?').run(id);
      const insert = db.prepare(`INSERT OR REPLACE INTO sonarr_episodes
        (sonarr_id, show_id, season, number, tvdb_id, has_file, monitored, title, overview, air_at_utc, air_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of episodes) {
        insert.run(e.id, id, e.seasonNumber, e.episodeNumber, e.tvdbId ? String(e.tvdbId) : null, e.hasFile ? 1 : 0, e.monitored ? 1 : 0,
          e.title ?? null, e.overview ?? null, toUtc(e.airDateUtc), e.airDate ?? null);
      }
      return id;
    })();
    if (showId === null) continue;
    seen.add(showId);
    linkSonarr(showId);
  }

  // Gone from Sonarr: drop availability, keep everything else.
  const gone = (db.prepare('SELECT id FROM shows WHERE in_sonarr = 1').pluck().all() as number[]).filter((id) => !seen.has(id));
  for (const id of gone) {
    db.transaction(() => {
      db.prepare('UPDATE shows SET in_sonarr = 0, sonarr_monitored = 0, sonarr_removed_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
      db.prepare('DELETE FROM sonarr_episodes WHERE show_id = ?').run(id);
    })();
    linkSonarr(id);
  }
  return { series: series.length, added, removed: gone.length, conflicts };
}
