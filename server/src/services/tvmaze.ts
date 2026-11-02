import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, nowIso, toUtc } from '../db.js';
import { fetchRetry, HttpError } from '../http.js';
import { addShowIds, closeReview, createShow, findShowsByIds, getShowIds, openReview, sortTitle } from './identity.js';
import { linkSonarr } from './link.js';

export interface TvmShow {
  id: number;
  name: string;
  status?: string | null;
  premiered?: string | null;
  summary?: string | null;
  updated?: number;
  network?: { name?: string } | null;
  webChannel?: { name?: string } | null;
  image?: { medium?: string; original?: string } | null;
  externals?: { tvrage?: number | null; thetvdb?: number | null; imdb?: string | null };
}

interface TvmEpisode {
  id: number;
  name?: string | null;
  season: number;
  number?: number | null;
  type?: string;
  airdate?: string | null;
  airstamp?: string | null;
  runtime?: number | null;
  summary?: string | null;
}

// One request at a time, spaced out, across every caller.
let queue: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    await new Promise((r) => setTimeout(r, config.tvmazeGapMs));
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

async function getJson<T>(p: string): Promise<T | null> {
  return throttled(async () => {
    const url = `${config.tvmazeUrl}${p}`;
    const res = await fetchRetry(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, url);
    return (await res.json()) as T;
  });
}

export async function testTvmaze(): Promise<string> {
  const s = await getJson<TvmShow>('/shows/1');
  if (!s) throw new Error('Unexpected response');
  return 'Connected';
}

const STATUS: Record<string, string> = {
  Running: 'Returning',
  Ended: 'Ended',
  'In Development': 'Upcoming',
  'To Be Determined': 'Unknown',
};

const stripHtml = (html?: string | null) =>
  html
    ? html.replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .trim() || null
    : null;

const externalIds = (t: TvmShow) => ({
  tvmaze: t.id,
  tvdb: t.externals?.thetvdb,
  imdb: t.externals?.imdb,
  tvrage: t.externals?.tvrage,
});

async function fetchPoster(showId: number, url: string): Promise<string | null> {
  const res = await throttled(() => fetchRetry(url));
  if (!res.ok) return null;
  const dir = path.join(config.dataDir, 'posters');
  mkdirSync(dir, { recursive: true });
  const file = `${showId}.jpg`;
  writeFileSync(path.join(dir, file), Buffer.from(await res.arrayBuffer()));
  return file;
}

/** Merge TVmaze's episode list. Episodes it no longer lists are flagged, never removed. */
function applyEpisodes(showId: number, list: TvmEpisode[]) {
  const at = nowIso();
  type Row = { id: number; season: number; number: number | null; kind: string; tvmaze: string | null };
  const rows = db.prepare(`SELECT e.id, e.season, e.number, e.kind, i.external_id AS tvmaze FROM episodes e
    LEFT JOIN episode_ids i ON i.episode_id = e.id AND i.provider = 'tvmaze' WHERE e.show_id = ?`).all(showId) as Row[];
  const byTvmaze = new Map(rows.filter((r) => r.tvmaze).map((r) => [r.tvmaze!, r]));
  const bySlot = new Map(rows.filter((r) => !r.tvmaze && r.number !== null && r.kind === 'regular').map((r) => [`${r.season}:${r.number}`, r]));

  const taken = new Set<string>();
  const plan: { row?: Row; ep: TvmEpisode; kind: string; number: number | null }[] = [];
  for (const ep of list) {
    const special = (ep.type && ep.type !== 'regular') || ep.number == null || ep.season === 0;
    const number = special ? null : ep.number!;
    const slot = `${ep.season}:${number}`;
    if (number !== null) {
      if (taken.has(slot)) continue; // TVmaze listing the same number twice: first one wins
      taken.add(slot);
    }
    plan.push({ row: byTvmaze.get(String(ep.id)) ?? (number !== null ? bySlot.get(slot) : undefined), ep, kind: special ? 'special' : 'regular', number });
  }

  const matched = new Set(plan.filter((p) => p.row).map((p) => p.row!.id));
  const orphan = db.prepare('UPDATE episodes SET orphaned = 1, updated_at = ? WHERE id = ?');
  let orphaned = 0;
  for (const r of rows) {
    // Sonarr's own season 0 rows carry no TVmaze ID and were never TVmaze's to withdraw.
    if (!matched.has(r.id) && (r.tvmaze || r.kind === 'regular')) {
      orphan.run(at, r.id);
      orphaned++;
    }
  }

  // Park renumbered rows first so a swap can't trip the unique slot index mid-update.
  const park = db.prepare('UPDATE episodes SET number = ? WHERE id = ?');
  for (const p of plan) {
    if (p.row && (p.row.season !== p.ep.season || p.row.number !== p.number)) park.run(-p.row.id, p.row.id);
  }

  const update = db.prepare(`UPDATE episodes SET season = ?, number = ?, kind = ?, title = ?, overview = ?, air_at_utc = ?, air_date = ?, runtime = ?, orphaned = 0, updated_at = ? WHERE id = ?`);
  const insert = db.prepare(`INSERT INTO episodes (show_id, season, number, kind, title, overview, air_at_utc, air_date, runtime, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const addId = db.prepare(`INSERT OR IGNORE INTO episode_ids (episode_id, provider, external_id) VALUES (?, 'tvmaze', ?)`);
  let added = 0;
  for (const { row, ep, kind, number } of plan) {
    const vals = [ep.season, number, kind, ep.name ?? null, stripHtml(ep.summary), toUtc(ep.airstamp), ep.airdate || null, ep.runtime ?? null] as const;
    let id = row?.id;
    if (id !== undefined) update.run(...vals, at, id);
    else {
      id = Number(insert.run(showId, ...vals, at, at).lastInsertRowid);
      added++;
    }
    addId.run(id, String(ep.id));
  }
  return { added, orphaned };
}

/** Fetch and merge one show. Provider failures throw and leave existing data untouched. */
export async function refreshShow(showId: number): Promise<'ok' | 'not_found' | 'needs_review'> {
  const ids = getShowIds(showId);
  const policy = db.prepare('SELECT metadata_policy FROM shows WHERE id = ?').pluck().get(showId) as string;
  if (policy === 'sonarr_only') {
    db.prepare(`UPDATE shows SET metadata_state = 'not_found', metadata_refreshed_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), showId);
    linkSonarr(showId);
    return 'not_found';
  }
  let tv: TvmShow | null = null;
  if (ids.tvmaze) tv = await getJson<TvmShow>(`/shows/${ids.tvmaze}`);
  if (!tv && ids.tvdb) tv = await getJson<TvmShow>(`/lookup/shows?thetvdb=${encodeURIComponent(ids.tvdb)}`);
  if (!tv && ids.imdb) tv = await getJson<TvmShow>(`/lookup/shows?imdb=${encodeURIComponent(ids.imdb)}`);

  const setState = db.prepare('UPDATE shows SET metadata_state = ?, metadata_refreshed_at = ?, updated_at = ? WHERE id = ?');
  const notFoundKey = `show_not_on_tvmaze:${showId}`;
  const conflictKey = `tvmaze_conflict:${showId}`;
  if (!tv) {
    const title = db.prepare('SELECT title FROM shows WHERE id = ?').pluck().get(showId) as string;
    db.transaction(() => {
      setState.run('not_found', nowIso(), nowIso(), showId);
      openReview(notFoundKey, 'show_not_on_tvmaze', showId, `"${title}" isn't on TVmaze`, { ids });
    })();
    linkSonarr(showId);
    return 'not_found';
  }

  const episodes = await getJson<TvmEpisode[]>(`/shows/${tv.id}/episodes?specials=1`);
  if (!episodes) throw new Error(`TVmaze has no episode list for show ${tv.id}`);

  const posterUrl = tv.image?.medium ?? tv.image?.original ?? null;
  const known = db.prepare('SELECT poster_url, poster_file FROM shows WHERE id = ?').get(showId) as { poster_url: string | null; poster_file: string | null };
  const posterFile = posterUrl && posterUrl !== known.poster_url ? await fetchPoster(showId, posterUrl).catch(() => null) : null;

  const show = tv;
  const result = db.transaction(() => {
    const problems = addShowIds(showId, externalIds(show), policy !== 'auto');
    if (problems.length) {
      setState.run('needs_review', nowIso(), nowIso(), showId);
      openReview(conflictKey, 'show_id_conflict', showId, `TVmaze's "${show.name}" disagrees with what's stored`, { tvmazeId: show.id, problems });
      return 'needs_review' as const;
    }
    closeReview(conflictKey);
    closeReview(notFoundKey);
    db.prepare(`UPDATE shows SET title = ?, sort_title = ?, status = ?, provider_status = ?, overview = ?, network = ?, premiere_date = ?,
        poster_url = COALESCE(?, poster_url), poster_file = COALESCE(?, poster_file), metadata_state = 'ok', metadata_version = ?, metadata_refreshed_at = ?, updated_at = ?
      WHERE id = ?`).run(
      show.name, sortTitle(show.name), STATUS[show.status ?? ''] ?? 'Unknown', show.status ?? null, stripHtml(show.summary),
      show.network?.name ?? show.webChannel?.name ?? null, show.premiered ?? null,
      posterFile ? posterUrl : null, posterFile, show.updated ?? null, nowIso(), nowIso(), showId,
    );
    applyEpisodes(showId, episodes);
    return 'ok' as const;
  })();
  linkSonarr(showId);
  return result;
}

const NOT_FOUND_RETRY_MS = 7 * 86400000;

/** Pending, failed and stale shows, plus any whose version moved in TVmaze's update index. */
export async function syncMetadata() {
  const shows = db.prepare(`SELECT s.id, s.metadata_state, s.metadata_version, s.metadata_refreshed_at, i.external_id AS tvmaze
    FROM shows s LEFT JOIN show_ids i ON i.show_id = s.id AND i.provider = 'tvmaze'`).all() as {
    id: number; metadata_state: string; metadata_version: number | null; metadata_refreshed_at: string | null; tvmaze: string | null;
  }[];
  const index = (await getJson<Record<string, number>>('/updates/shows')) ?? {};
  const now = Date.now();
  const due = shows.filter((s) => {
    if (s.metadata_state === 'pending' || s.metadata_state === 'error') return true;
    if (s.metadata_state === 'not_found') return !s.metadata_refreshed_at || now - Date.parse(s.metadata_refreshed_at) > NOT_FOUND_RETRY_MS;
    if (s.metadata_state !== 'ok' || !s.tvmaze) return false;
    const version = index[s.tvmaze];
    return version !== undefined && version !== s.metadata_version;
  });

  const counts = { due: due.length, ok: 0, notFound: 0, needsReview: 0, failed: 0 };
  const errors: string[] = [];
  for (const s of due) {
    try {
      const r = await refreshShow(s.id);
      if (r === 'ok') counts.ok++;
      else if (r === 'not_found') counts.notFound++;
      else counts.needsReview++;
    } catch (err) {
      counts.failed++;
      if (errors.length < 5) errors.push(`show ${s.id}: ${(err as Error).message}`);
      // A show with good data stays 'ok' and retries when its version next changes.
      if (s.metadata_state !== 'ok') db.prepare(`UPDATE shows SET metadata_state = 'error', updated_at = ? WHERE id = ?`).run(nowIso(), s.id);
    }
  }
  return errors.length ? { ...counts, errors } : counts;
}

export async function searchShows(q: string) {
  const hits = (await getJson<{ score: number; show: TvmShow }[]>(`/search/shows?q=${encodeURIComponent(q)}`)) ?? [];
  return hits.map(({ show }) => {
    const existing = findShowsByIds(externalIds(show))[0] ?? null;
    return {
      tvmazeId: show.id,
      title: show.name,
      premiered: show.premiered ?? null,
      network: show.network?.name ?? show.webChannel?.name ?? null,
      status: STATUS[show.status ?? ''] ?? 'Unknown',
      overview: stripHtml(show.summary),
      image: show.image?.medium ?? null,
      existingShowId: existing,
    };
  });
}

/** Add by TVmaze ID. A show already known by any ID is followed rather than duplicated. */
export async function addShow(tvmazeId: number): Promise<{ showId: number; created: boolean }> {
  const tv = await getJson<TvmShow>(`/shows/${tvmazeId}`);
  if (!tv) throw new Error('TVmaze has no such show');
  const matches = findShowsByIds(externalIds(tv));
  if (matches.length > 1) {
    throw new Error('These IDs match more than one show already; check the review queue');
  }
  if (matches.length === 1) {
    db.prepare(`UPDATE shows SET tracking_state = 'following', updated_at = ? WHERE id = ?`).run(nowIso(), matches[0]);
    return { showId: matches[0], created: false };
  }
  const showId = db.transaction(() => {
    const id = createShow(tv.name, 'following');
    addShowIds(id, externalIds(tv));
    return id;
  })();
  await refreshShow(showId);
  return { showId, created: true };
}
