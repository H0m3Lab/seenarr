import { db } from '../db.js';
import { setWatched, type WatchDate } from './events.js';

export interface EpisodeRow {
  id: number;
  show_id: number;
  season: number;
  number: number | null;
  kind: 'regular' | 'special';
  title: string | null;
  overview: string | null;
  air_at_utc: string | null;
  air_date: string | null;
  runtime: number | null;
  orphaned: number;
  has_file: number;
  in_plex: number;
  sonarr_monitored: number;
  state: 'watched' | 'unwatched' | null;
  occurred_at_utc: string | null;
  date_quality: string | null;
  source: string | null;
}

export interface EpisodeBrief {
  id: number;
  season: number;
  number: number | null;
  title: string | null;
  air_at_utc: string | null;
  air_date: string | null;
  available: boolean;
}

export interface Progress {
  aired: number;
  watched: number;
  remaining: number;
  percent: number;
  lastWatched: (EpisodeBrief & { watchedAt: string | null; source: string | null }) | null;
  nextToWatch: EpisodeBrief | null;
  nextAfterLast: EpisodeBrief | null; // only when it differs from nextToWatch (you skipped something)
  nextToAir: EpisodeBrief | null;
  availableUnwatched: number;
}

export function localToday(now: Date): string {
  return now.toLocaleDateString('en-CA'); // YYYY-MM-DD in the server's time zone
}

/** Date-only episodes count as aired once that day has passed, so they're never "behind" early. */
export function isAired(ep: Pick<EpisodeRow, 'air_at_utc' | 'air_date'>, now: Date): boolean {
  if (ep.air_at_utc) return ep.air_at_utc <= now.toISOString();
  if (ep.air_date) return ep.air_date < localToday(now);
  return false;
}

const brief = (e: EpisodeRow): EpisodeBrief => ({
  id: e.id,
  season: e.season,
  number: e.number,
  title: e.title,
  air_at_utc: e.air_at_utc,
  air_date: e.air_date,
  available: !!e.has_file || !!e.in_plex,
});

const inOrder = (a: EpisodeRow, b: EpisodeRow) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0);

/** Specials, unaired and provider-orphaned episodes never count toward progress. */
export function computeProgress(all: EpisodeRow[], now = new Date()): Progress {
  const regular = all.filter((e) => e.kind === 'regular' && e.number !== null).sort(inOrder);
  const current = regular.filter((e) => !e.orphaned);
  const aired = current.filter((e) => isAired(e, now));
  const watchedAired = aired.filter((e) => e.state === 'watched');
  const unwatchedAired = aired.filter((e) => e.state !== 'watched');

  // Latest dated watch wins; if nothing is dated, fall back to the furthest episode watched.
  const watchedAll = regular.filter((e) => e.state === 'watched');
  const dated = watchedAll.filter((e) => e.occurred_at_utc);
  let last: EpisodeRow | undefined;
  if (dated.length) {
    last = dated.reduce((best, e) => {
      const cmp = e.occurred_at_utc!.localeCompare(best.occurred_at_utc!);
      return cmp > 0 || (cmp === 0 && inOrder(e, best) > 0) ? e : best;
    });
  } else {
    last = watchedAll[watchedAll.length - 1];
  }

  const next = unwatchedAired[0] ?? null;
  const after = last ? unwatchedAired.find((e) => inOrder(e, last!) > 0) ?? null : null;
  const toAir = current.filter((e) => !isAired(e, now) && (e.air_at_utc || e.air_date))[0] ?? null;

  return {
    aired: aired.length,
    watched: watchedAired.length,
    remaining: unwatchedAired.length,
    percent: aired.length ? Math.floor((watchedAired.length / aired.length) * 100) : 0,
    lastWatched: last ? { ...brief(last), watchedAt: last.occurred_at_utc, source: last.source } : null,
    nextToWatch: next ? brief(next) : null,
    nextAfterLast: after && next && after.id !== next.id ? brief(after) : null,
    nextToAir: toAir ? brief(toAir) : null,
    availableUnwatched: unwatchedAired.filter((e) => e.has_file || e.in_plex).length,
  };
}

const EPISODE_COLUMNS = `
  e.id, e.show_id, e.season, e.number, e.kind, e.title, e.overview, e.air_at_utc, e.air_date, e.runtime,
  e.orphaned, e.has_file, e.in_plex, e.sonarr_monitored,
  st.state, st.occurred_at_utc, st.date_quality, st.source`;

export function episodesForShow(showId: number): EpisodeRow[] {
  return db.prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes e LEFT JOIN episode_state st ON st.episode_id = e.id
    WHERE e.show_id = ? ORDER BY e.season, e.number, e.air_date, e.id`).all(showId) as EpisodeRow[];
}

/**
 * Whole shows: every aired regular episode, never specials, unaired or orphaned ones.
 * Already-watched episodes are skipped by setWatched, so their real dates stay.
 */
export function markShowsWatched(showIds: number[], date: WatchDate = { mode: 'unknown' }, now = new Date()): number {
  const ids = showIds.flatMap((showId) =>
    episodesForShow(showId)
      .filter((e) => e.kind === 'regular' && !e.orphaned && isAired(e, now))
      .map((e) => e.id),
  );
  return setWatched(ids, true, date);
}

export interface ShowRow {
  id: number;
  title: string;
  sort_title: string;
  status: string;
  provider_status: string | null;
  overview: string | null;
  network: string | null;
  premiere_date: string | null;
  poster_file: string | null;
  tracking_state: 'discovered' | 'following' | 'archived';
  metadata_state: string;
  metadata_refreshed_at: string | null;
  in_sonarr: number;
  sonarr_monitored: number;
  sonarr_removed_at: string | null;
}

export type ShowSummary = ShowRow & { progress: Progress; inPlex: boolean; hasFiles: boolean; seasons: number };

export function summarise(show: ShowRow, eps: EpisodeRow[], now = new Date()): ShowSummary {
  const regular = eps.filter((e) => e.kind === 'regular');
  return {
    ...show,
    progress: computeProgress(eps, now),
    inPlex: eps.some((e) => e.in_plex),
    hasFiles: eps.some((e) => e.has_file),
    seasons: new Set(regular.map((e) => e.season)).size,
  };
}

export function allSummaries(now = new Date()): ShowSummary[] {
  const shows = db.prepare('SELECT * FROM shows ORDER BY sort_title').all() as ShowRow[];
  const eps = db.prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes e LEFT JOIN episode_state st ON st.episode_id = e.id`).all() as EpisodeRow[];
  const byShow = new Map<number, EpisodeRow[]>();
  for (const e of eps) {
    const list = byShow.get(e.show_id);
    if (list) list.push(e);
    else byShow.set(e.show_id, [e]);
  }
  return shows.map((s) => summarise(s, byShow.get(s.id) ?? [], now));
}

export const isEnded = (s: { status: string }) => s.status === 'Ended' || s.status === 'Canceled';

/** Dashboard contains only shows you follow. An unfinished ended show is in both Continue and Ended. */
export function dashboard(now = new Date()) {
  const following = allSummaries(now).filter((s) => s.tracking_state === 'following');
  const byRecent = (a: ShowSummary, b: ShowSummary) =>
    (b.progress.lastWatched?.watchedAt ?? '').localeCompare(a.progress.lastWatched?.watchedAt ?? '');
  const started = following.filter((s) => s.progress.lastWatched);
  const behind = started.filter((s) => s.progress.nextToWatch);

  // "New" = you were caught up, then it aired after your last watch. Otherwise you're mid-show.
  const isNew = (s: ShowSummary) => {
    const watchedAt = s.progress.lastWatched?.watchedAt;
    const next = s.progress.nextToWatch!;
    if (!watchedAt) return false;
    return (next.air_at_utc ?? next.air_date ?? '') > watchedAt;
  };

  const airKey = (s: ShowSummary) => s.progress.nextToAir?.air_at_utc ?? s.progress.nextToAir?.air_date ?? '';
  return {
    continueWatching: behind.filter((s) => !isNew(s)).sort(byRecent),
    newEpisodes: behind.filter(isNew).sort(byRecent),
    comingSoon: following.filter((s) => s.progress.nextToAir).sort((a, b) => airKey(a).localeCompare(airKey(b))),
    caughtUp: started.filter((s) => !s.progress.nextToWatch && !isEnded(s)).sort(byRecent),
    notStarted: following.filter((s) => !s.progress.lastWatched),
    ended: following.filter(isEnded).sort((a, b) => a.sort_title.localeCompare(b.sort_title)),
  };
}
