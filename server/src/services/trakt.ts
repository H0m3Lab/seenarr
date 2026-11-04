import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { addExternalWatch } from './events.js';
import { addShowIds, findShowsByIds, isDeletedShow, type IdSet } from './identity.js';
import { importsDir } from './prime.js';
import { addShow } from './tvmaze.js';
import { fetchRetry } from '../http.js';
import { config } from '../config.js';

/**
 * Trakt "export your data" folder (watched-history-*.json), saved in DATA_DIR/imports. Every
 * record carries TVDB/IMDb/TMDB IDs, so shows and episodes are matched by ID, never by name.
 * Plays that Trakt shows at the same minute in bulk (25+) were "mark as watched" clicks, not
 * viewing times, so they are imported with the date unknown. Run only from the Import page.
 */

const DIR_RE = /^trakt[\w.-]*$/;
const BULK_MINUTE = 25;

interface TraktIds { trakt?: number; tvdb?: number | null; imdb?: string | null; tmdb?: number | null }
interface TraktPlay {
  id: number;
  watched_at: string;
  action: string;
  type: 'episode' | 'movie';
  episode?: { season: number; number: number; title: string | null; ids: TraktIds };
  show?: { title: string; year: number | null; ids: TraktIds };
}

export function listTraktExports() {
  try {
    return readdirSync(importsDir())
      .filter((f) => DIR_RE.test(f) && statSync(path.join(importsDir(), f)).isDirectory())
      .map((f) => ({ folder: f, files: readdirSync(path.join(importsDir(), f)).filter((x) => /^watched-history-\d+\.json$/.test(x)).length }));
  } catch {
    return [];
  }
}

function readPlays(folder: string): TraktPlay[] {
  if (!DIR_RE.test(folder)) throw new Error('Bad folder name');
  const dir = path.join(importsDir(), folder);
  if (!existsSync(dir)) throw new Error('No such export folder');
  const files = readdirSync(dir).filter((f) => /^watched-history-\d+\.json$/.test(f));
  if (!files.length) throw new Error("That folder has no watched-history files; is it a Trakt export?");
  return files.flatMap((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as TraktPlay[]);
}

const showIdSet = (ids: TraktIds): IdSet => ({ tvdb: ids.tvdb, imdb: ids.imdb, tmdb: ids.tmdb, trakt: ids.trakt });

async function tvmazeIdFor(ids: TraktIds): Promise<number | null> {
  const tries = [ids.tvdb ? `thetvdb=${ids.tvdb}` : null, ids.imdb ? `imdb=${ids.imdb}` : null].filter(Boolean);
  for (const q of tries) {
    const res = await fetchRetry(`${config.tvmazeUrl}/lookup/shows?${q}`, {}, 30000).catch(() => null);
    if (res?.ok) return ((await res.json()) as { id: number }).id;
  }
  return null;
}

type Plan = Awaited<ReturnType<typeof buildPlan>>;

function buildPlan(folder: string) {
  const plays = readPlays(folder);
  const episodes = plays.filter((p) => p.type === 'episode' && p.episode && p.show);
  const perMinute = new Map<string, number>();
  for (const p of episodes) perMinute.set(p.watched_at.slice(0, 16), (perMinute.get(p.watched_at.slice(0, 16)) ?? 0) + 1);

  const known = db.prepare(`SELECT 1 FROM watch_events WHERE source = 'trakt' AND source_event_key = ?`).pluck();
  const byTvdb = db.prepare(`SELECT e.id, e.show_id FROM episode_ids i JOIN episodes e ON e.id = i.episode_id WHERE i.provider = 'tvdb' AND i.external_id = ?`);
  const bySlot = db.prepare(`SELECT id FROM episodes WHERE show_id = ? AND season = ? AND number = ? AND orphaned = 0`).pluck();
  const stateOf = db.prepare('SELECT state FROM episode_state WHERE episode_id = ?').pluck();
  const titleOf = db.prepare('SELECT title FROM shows WHERE id = ?').pluck();

  const showFor = new Map<number, number | null>(); // trakt show id -> our show (null = not here)
  const planned: { key: string; episodeId: number; showId: number; occurredAt: string | null; bulk: boolean; known: boolean; newlyWatched: boolean; play: TraktPlay }[] = [];
  const unplaced: { show: string; episode: string; watchedAt: string; reason: string }[] = [];
  const missing = new Map<number, { title: string; year: number | null; ids: TraktIds; plays: number }>();
  const deleted = new Map<string, number>();
  const wouldWatch = new Set<number>();

  for (const p of episodes) {
    const s = p.show!;
    const e = p.episode!;
    const tId = s.ids.trakt ?? -1;
    if (!showFor.has(tId)) {
      const matches = findShowsByIds(showIdSet(s.ids));
      showFor.set(tId, matches.length === 1 ? matches[0] : matches.length > 1 ? -1 : null);
    }
    const showId = showFor.get(tId)!;
    const label = `S${e.season}E${e.number}`;
    if (showId === -1) {
      unplaced.push({ show: s.title, episode: label, watchedAt: p.watched_at, reason: 'IDs point at more than one show here' });
      continue;
    }
    if (showId === null) {
      if (isDeletedShow(showIdSet(s.ids))) {
        deleted.set(s.title, (deleted.get(s.title) ?? 0) + 1);
        continue;
      }
      const m = missing.get(tId) ?? { title: s.title, year: s.year, ids: s.ids, plays: 0 };
      m.plays++;
      missing.set(tId, m);
      continue;
    }
    let episodeId: number | undefined;
    if (e.ids.tvdb) {
      const hit = byTvdb.get(String(e.ids.tvdb)) as { id: number; show_id: number } | undefined;
      if (hit && hit.show_id === showId) episodeId = hit.id;
    }
    episodeId ??= bySlot.get(showId, e.season, e.number) as number | undefined;
    if (episodeId === undefined) {
      unplaced.push({ show: titleOf.get(showId) as string, episode: `${label}${e.title ? ` "${e.title}"` : ''}`, watchedAt: p.watched_at, reason: `No ${label} in this show's episode list` });
      continue;
    }
    const key = `history:${p.id}`;
    const bulk = (perMinute.get(p.watched_at.slice(0, 16)) ?? 0) >= BULK_MINUTE;
    const isKnown = known.get(key) !== undefined;
    // Only episodes with no history at all change: a later unwatch of yours always outranks an older Trakt play.
    const newly = !isKnown && stateOf.get(episodeId) === undefined && !wouldWatch.has(episodeId);
    if (newly) wouldWatch.add(episodeId);
    planned.push({ key, episodeId, showId, occurredAt: bulk ? null : new Date(p.watched_at).toISOString(), bulk, known: isKnown, newlyWatched: newly, play: p });
  }
  return { plays: plays.length, movies: plays.length - episodes.length, planned, unplaced, missing: [...missing.values()], deleted: [...deleted.entries()].map(([show, plays]) => ({ show, plays })) };
}

function summarise(plan: Plan) {
  const titleOf = db.prepare('SELECT title FROM shows WHERE id = ?').pluck();
  const shows = new Map<number, { showId: number; show: string; toAdd: number; newlyWatched: number; alreadyImported: number }>();
  for (const p of plan.planned) {
    const row = shows.get(p.showId) ?? { showId: p.showId, show: titleOf.get(p.showId) as string, toAdd: 0, newlyWatched: 0, alreadyImported: 0 };
    if (p.known) row.alreadyImported++;
    else row.toAdd++;
    if (p.newlyWatched) row.newlyWatched++;
    shows.set(p.showId, row);
  }
  const fresh = plan.planned.filter((p) => !p.known);
  return {
    plays: plan.plays,
    episodePlays: plan.plays - plan.movies,
    movies: plan.movies,
    toAdd: fresh.length,
    datedUnknown: fresh.filter((p) => p.bulk).length,
    newlyWatched: fresh.filter((p) => p.newlyWatched).length,
    alreadyImported: plan.planned.length - fresh.length,
    shows: [...shows.values()].sort((a, b) => a.show.localeCompare(b.show)),
    missing: plan.missing.sort((a, b) => b.plays - a.plays).map((m) => ({ title: m.title, year: m.year, plays: m.plays })),
    deleted: plan.deleted,
    unplaced: plan.unplaced,
  };
}

export function previewTrakt(folder: string) {
  return { folder, ...summarise(buildPlan(folder)) };
}

/**
 * Adds shows Trakt knows and TV Tracker doesn't (found on TVmaze by TVDB/IMDb ID), then the
 * watches. A copy of the database is saved first.
 */
export async function applyTrakt(folder: string) {
  const backup = path.join(importsDir(), `before-trakt-import-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await db.backup(backup);
  const first = buildPlan(folder);
  const showsAdded: string[] = [];
  const showsNotFound: string[] = [];
  for (const m of first.missing) {
    await new Promise((r) => setTimeout(r, config.tvmazeGapMs));
    const tvmazeId = await tvmazeIdFor(m.ids);
    if (!tvmazeId) {
      showsNotFound.push(m.title);
      continue;
    }
    try {
      const r = await addShow(tvmazeId);
      addShowIds(r.showId, { trakt: m.ids.trakt }, true);
      if (r.created) showsAdded.push(m.title);
    } catch {
      showsNotFound.push(m.title);
    }
  }
  const plan = buildPlan(folder);
  let added = 0;
  db.transaction(() => {
    const remember = new Set<number>();
    for (const p of plan.planned) {
      if (!remember.has(p.showId) && p.play.show?.ids.trakt) {
        addShowIds(p.showId, { trakt: p.play.show.ids.trakt }, true);
        remember.add(p.showId);
      }
      if (p.known) continue;
      if (addExternalWatch({
        episodeId: p.episodeId, source: 'trakt', key: p.key, occurredAt: p.occurredAt,
        raw: { folder, traktHistoryId: p.play.id, watchedAt: p.play.watched_at, action: p.play.action, bulkMarked: p.bulk || undefined, show: p.play.show?.title, episode: `S${p.play.episode?.season}E${p.play.episode?.number}` },
      })) added++;
    }
  })();
  return { added, showsAdded, showsNotFound, ...summarise(plan), backup: path.basename(backup) };
}
