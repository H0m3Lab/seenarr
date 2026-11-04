import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, getSetting, nowIso, setSetting } from '../db.js';
import { addExternalWatch } from './events.js';
import { searchShows } from './tvmaze.js';

/**
 * Prime Video watch history, saved from the account's Watch History page as JSON. The file
 * has titles, not IDs, so matching is careful: a show matches only by its exact (cleaned)
 * name or a link you chose; an episode by season + number with an agreeing title, or by a
 * unique title. Anything else is reported and left alone. Nothing here runs on a schedule.
 */

export const importsDir = () => path.join(config.dataDir, 'imports');
const FILE_RE = /^[\w.-]+\.json$/;

interface PrimeFile {
  source?: string;
  entries: { date: string; title: string; kind: 'series' | 'movie'; episodes: string[]; gti: string }[];
}

export function listImportFiles() {
  try {
    return readdirSync(importsDir())
      .filter((f) => FILE_RE.test(f))
      .map((f) => {
        const st = statSync(path.join(importsDir(), f));
        return { file: f, bytes: st.size, modified: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

function readPrimeFile(file: string): PrimeFile {
  if (!FILE_RE.test(file)) throw new Error('Bad file name');
  const data = JSON.parse(readFileSync(path.join(importsDir(), file), 'utf8')) as PrimeFile;
  if (!Array.isArray(data.entries)) throw new Error("That file isn't a Prime Video history export");
  return data;
}

// ---- Title cleaning ----------------------------------------------------------------------

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export const norm = (s: string | null | undefined) =>
  (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’']/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Compare key for show names: no leading article, no year suffix. */
export const showKey = (title: string) => norm(title.replace(/\s*\(\d{4}\)\s*$/, '')).replace(/^(the|a|an) /, '');

/** "The Boys – Season 4", "Vikings Season 2", "WHEEL OF TIME, THE (2021) - Season 3", "Evil S3 - Season 3", "Cajun Pawn Stars Volume 3". */
export function parseSeriesTitle(raw: string): { show: string; season: number | null } {
  let t = raw.replace(/\(4K UHD\)/gi, '').trim();
  let season: number | null = null;
  const m = /^(.*?)[\s,:–—-]*\b(?:Season|Series|Volume)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i.exec(t);
  if (m) {
    t = m[1];
    season = /^\d+$/.test(m[2]) ? Number(m[2]) : WORD_NUM[m[2].toLowerCase()];
  }
  t = t.replace(/\s+S\d+\s*$/i, '').replace(/[\s,:–—-]+$/, '').trim();
  const year = /\s*\(\d{4}\)\s*$/.exec(t);
  if (year) t = t.slice(0, year.index).trim();
  const article = /^(.*),\s*(the|a|an)$/i.exec(t);
  if (article) t = `${article[2]} ${article[1]}`;
  return { show: t, season };
}

export function parseEpisode(raw: string): { number: number; title: string } | null {
  const m = /^Episode\s+(\d+)\s*:\s*(.*)$/i.exec(raw.trim());
  return m ? { number: Number(m[1]), title: m[2].trim() } : null;
}

const isGenericTitle = (t: string) => /^(episode \d+|)$/.test(norm(t));

function titlesAgree(a: string | null, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = new Set(x.split(' '));
  const by = new Set(y.split(' '));
  const shared = [...ax].filter((w) => by.has(w)).length;
  return shared / Math.max(ax.size, by.size) >= 0.5;
}

/** "October 1, 2026" -> local noon that day, as UTC ISO. Only the day is known. */
function dayToIso(day: string): string | null {
  const ms = Date.parse(`${day} 12:00:00`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ---- Show links you chose ----------------------------------------------------------------

const ALIAS_KEY = 'prime_show_links';
const getLinks = (): Record<string, number> => JSON.parse(getSetting(ALIAS_KEY, '{}')) as Record<string, number>;

export function linkPrimeShow(primeShow: string, showId: number) {
  if (!db.prepare('SELECT 1 FROM shows WHERE id = ?').get(showId)) throw new Error('No such show');
  const links = getLinks();
  links[showKey(primeShow)] = showId;
  setSetting(ALIAS_KEY, JSON.stringify(links));
}

// ---- Matching ----------------------------------------------------------------------------

interface Ep { id: number; season: number; number: number | null; title: string | null }

type Planned = {
  key: string; episodeId: number; showId: number; occurredAt: string | null; label: string; day: string;
  primeShow: string; primeTitle: string; how: 'number' | 'title'; known: boolean; alreadyWatched: boolean;
};
type Unplaced = { day: string; primeShow: string; season: number | null; episode: string; reason: string };

function buildPlan(file: string) {
  const data = readPrimeFile(file);
  const shows = db.prepare('SELECT id, title FROM shows').all() as { id: number; title: string }[];
  const byKey = new Map<string, number[]>();
  for (const s of shows) {
    const k = showKey(s.title);
    byKey.set(k, [...(byKey.get(k) ?? []), s.id]);
  }
  const links = getLinks();
  const epsOf = new Map<number, Ep[]>();
  const episodes = (showId: number) => {
    let list = epsOf.get(showId);
    if (!list) {
      list = db.prepare(`SELECT id, season, number, title FROM episodes WHERE show_id = ? AND kind = 'regular' AND orphaned = 0`).all(showId) as Ep[];
      epsOf.set(showId, list);
    }
    return list;
  };
  const known = db.prepare(`SELECT 1 FROM watch_events WHERE source = 'prime' AND source_event_key = ?`).pluck();
  const stateOf = db.prepare(`SELECT state FROM episode_state WHERE episode_id = ?`).pluck();
  const titleOf = db.prepare('SELECT title FROM shows WHERE id = ?').pluck();

  const planned: Planned[] = [];
  const unplaced: Unplaced[] = [];
  const missing = new Map<string, { primeShow: string; episodes: number; lastWatched: string }>();
  let movies = 0;
  let trailers = 0;
  let repeats = 0;
  const seen = new Set<string>();

  for (const entry of data.entries) {
    if (entry.kind === 'movie') {
      if (/^Episode 0:/i.test(entry.title)) trailers++;
      else movies++;
      continue;
    }
    const { show, season } = parseSeriesTitle(entry.title);
    const k = showKey(show);
    const candidates = links[k] !== undefined ? [links[k]] : (byKey.get(k) ?? []);
    for (const rawEp of entry.episodes) {
      const ep = parseEpisode(rawEp);
      if (!ep || ep.number === 0) {
        trailers++;
        continue;
      }
      const occurredAt = dayToIso(entry.date);
      const key = `${entry.gti}:${season ?? '?'}x${ep.number}:${entry.date}`;
      if (seen.has(key)) {
        repeats++; // Amazon sometimes lists the same play twice
        continue;
      }
      seen.add(key);
      const unplace = (reason: string) => unplaced.push({ day: entry.date, primeShow: show || entry.title, season, episode: rawEp, reason });
      if (!k) {
        unplace("Amazon didn't give the show's name");
        continue;
      }
      if (candidates.length === 0) {
        const m = missing.get(k) ?? { primeShow: show, episodes: 0, lastWatched: entry.date };
        m.episodes++;
        missing.set(k, m);
        continue;
      }
      if (candidates.length > 1) {
        unplace(`More than one show here is called "${show}"; link the right one`);
        continue;
      }
      const showId = candidates[0];
      const list = episodes(showId);
      const generic = isGenericTitle(ep.title);
      const byTitle = generic ? [] : list.filter((e) => norm(e.title) === norm(ep.title));
      let match: Ep | undefined;
      let how: 'number' | 'title' = 'number';
      if (season !== null) {
        const slot = list.find((e) => e.season === season && e.number === ep.number);
        if (slot && (generic || titlesAgree(slot.title, ep.title))) match = slot;
        else if (byTitle.length === 1) {
          match = byTitle[0];
          how = 'title';
        } else if (slot) {
          unplace(`S${season}E${ep.number} here is "${slot.title ?? 'untitled'}", not "${ep.title}"`);
          continue;
        } else {
          unplace(`No S${season}E${ep.number} in this show's episode list`);
          continue;
        }
      } else if (byTitle.length === 1) {
        match = byTitle[0];
        how = 'title';
      } else {
        unplace(byTitle.length > 1 ? `No season given and several episodes are called "${ep.title}"` : `No season given and no episode called "${ep.title}"`);
        continue;
      }
      planned.push({
        key, episodeId: match.id, showId, occurredAt, day: entry.date, how,
        label: `${titleOf.get(showId) as string} S${match.season}E${match.number}`,
        primeShow: show, primeTitle: rawEp,
        known: known.get(key) !== undefined,
        alreadyWatched: stateOf.get(match.id) === 'watched',
      });
    }
  }
  return { planned, unplaced, missing: [...missing.values()].sort((a, b) => b.episodes - a.episodes), movies, trailers, repeats, entries: data.entries.length };
}

const suggestionCache = new Map<string, { at: number; hits: Awaited<ReturnType<typeof searchShows>> }>();

async function suggestionsFor(name: string) {
  const hit = suggestionCache.get(name);
  if (hit && Date.now() - hit.at < 3600000) return hit.hits;
  const hits = (await searchShows(name).catch(() => [])).slice(0, 3);
  suggestionCache.set(name, { at: Date.now(), hits });
  return hits;
}

export async function previewPrime(file: string) {
  const plan = buildPlan(file);
  const byShow = new Map<string, { show: string; showId: number; newWatches: number; alreadyImported: number; newlyWatched: number; byTitle: number }>();
  for (const p of plan.planned) {
    const row = byShow.get(String(p.showId)) ?? { show: p.label.replace(/ S\d+E\d+$/, ''), showId: p.showId, newWatches: 0, alreadyImported: 0, newlyWatched: 0, byTitle: 0 };
    if (p.known) row.alreadyImported++;
    else {
      row.newWatches++;
      if (!p.alreadyWatched) row.newlyWatched++;
    }
    if (p.how === 'title') row.byTitle++;
    byShow.set(String(p.showId), row);
  }
  const missing = [];
  for (const m of plan.missing) missing.push({ ...m, suggestions: await suggestionsFor(m.primeShow) });
  return {
    file,
    entries: plan.entries,
    episodesInFile: plan.planned.length + plan.unplaced.length + plan.missing.reduce((n, m) => n + m.episodes, 0),
    toAdd: plan.planned.filter((p) => !p.known).length,
    newlyWatched: plan.planned.filter((p) => !p.known && !p.alreadyWatched).length,
    alreadyImported: plan.planned.filter((p) => p.known).length,
    skipped: { movies: plan.movies, trailers: plan.trailers, repeats: plan.repeats },
    shows: [...byShow.values()].sort((a, b) => a.show.localeCompare(b.show)),
    unplaced: plan.unplaced,
    missing,
  };
}

/** Adds the matched watches. A copy of the database is saved first, next to the import file. */
export async function applyPrime(file: string) {
  const backup = path.join(importsDir(), `before-prime-import-${nowIso().replace(/[:.]/g, '-')}.db`);
  await db.backup(backup);
  const plan = buildPlan(file);
  let added = 0;
  db.transaction(() => {
    for (const p of plan.planned) {
      if (p.known) continue;
      if (addExternalWatch({
        episodeId: p.episodeId, source: 'prime', key: p.key, occurredAt: p.occurredAt, dateQuality: 'date_only',
        raw: { file, day: p.day, primeShow: p.primeShow, primeEpisode: p.primeTitle, matchedBy: p.how },
      })) added++;
    }
  })();
  return { added, alreadyImported: plan.planned.filter((p) => p.known).length, unplaced: plan.unplaced.length, missingShows: plan.missing.length, backup: path.basename(backup) };
}
