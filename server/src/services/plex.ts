import { config } from '../config.js';
import { db, nowIso } from '../db.js';
import { fetchRetry, HttpError } from '../http.js';
import { addExternalWatch } from './events.js';
import { addShowIds, createShow, findShowsByIds, openReview, type IdSet } from './identity.js';
import { daysApart, MAX_AIR_DATE_DRIFT_DAYS } from './link.js';
import { refreshShow } from './tvmaze.js';

interface PlexGuid { id: string }

export interface PlexEpisode {
  ratingKey: string;
  guid?: string;
  title?: string;
  parentIndex?: number;
  index?: number;
  grandparentRatingKey?: string;
  grandparentGuid?: string;
  grandparentTitle?: string;
  originallyAvailableAt?: string;
  viewCount?: number;
  lastViewedAt?: number;
  Guid?: PlexGuid[];
}

interface PlexShow {
  ratingKey: string;
  guid?: string;
  title?: string;
  Guid?: PlexGuid[];
}

async function get<T>(path: string): Promise<T> {
  if (!config.plexUrl || !config.plexToken) throw new Error('Plex is not configured');
  // The token travels in a header, so it can't end up in a logged URL or error message.
  const url = `${config.plexUrl}${path}`;
  const res = await fetchRetry(url, { headers: { 'X-Plex-Token': config.plexToken, Accept: 'application/json' } }, 120000);
  if (!res.ok) throw new HttpError(res.status, url.split('?')[0]);
  return (await res.json()) as T;
}

async function getAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  const join = path.includes('?') ? '&' : '?';
  for (let start = 0; ; start += 1000) {
    const { MediaContainer: m } = await get<{ MediaContainer: { totalSize?: number; Metadata?: T[] } }>(`${path}${join}X-Plex-Container-Start=${start}&X-Plex-Container-Size=1000`);
    out.push(...(m.Metadata ?? []));
    if (!m.Metadata?.length || out.length >= (m.totalSize ?? 0)) return out;
  }
}

export async function testPlex(): Promise<string> {
  const { MediaContainer: m } = await get<{ MediaContainer: { version: string; myPlexSubscription?: boolean } }>('/');
  return `Connected, Plex ${m.version}, Plex Pass ${m.myPlexSubscription ? 'active' : 'not active'}`;
}

const guidOf = (item: { Guid?: PlexGuid[] }, provider: string) =>
  item.Guid?.find((g) => g.id.startsWith(`${provider}://`))?.id.slice(provider.length + 3);

const showIdSet = (s: PlexShow): IdSet => ({ tvdb: guidOf(s, 'tvdb'), imdb: guidOf(s, 'imdb'), tmdb: guidOf(s, 'tmdb'), plex: s.guid });

type ShowLookup = { showId: number | null; reason: string };

const holdReason = (guid?: string) =>
  guid ? (db.prepare('SELECT reason FROM plex_holds WHERE plex_guid = ?').pluck().get(guid) as string | undefined) : undefined;

/** Which of our shows this Plex show is. External IDs only. Several matches go to review. */
function findShow(s: PlexShow): ShowLookup {
  const held = holdReason(s.guid);
  if (held) return { showId: null, reason: `On hold: ${held}` };
  const { plex: _plex, ...external } = showIdSet(s);
  const matches = findShowsByIds(external);
  if (matches.length > 1) {
    openReview(`plex_conflict:${s.ratingKey}`, 'show_id_conflict', matches[0], `Plex's "${s.title}" matches ${matches.length} different shows`, { matches, ids: external });
    return { showId: null, reason: 'Plex show matches more than one show here' };
  }
  if (matches.length === 1) {
    addShowIds(matches[0], showIdSet(s));
    return { showId: matches[0], reason: '' };
  }
  return { showId: null, reason: Object.values(external).some(Boolean) ? 'Show not in the tracker' : 'Plex has no external IDs for this show' };
}

/** A show gone from Sonarr is still yours: add it by external ID, never by title. */
async function addMissingShow(s: PlexShow): Promise<number | null> {
  if (!guidOf(s, 'tvdb') && !guidOf(s, 'imdb')) return null;
  const id = db.transaction(() => {
    const created = createShow(s.title ?? 'Unknown', 'following');
    addShowIds(created, showIdSet(s));
    return created;
  })();
  await refreshShow(id).catch(() => undefined); // stays 'pending'; the next metadata pass retries
  return id;
}

/** Place a Plex episode on one of ours, or explain why it can't be placed. */
function matchEpisode(item: PlexEpisode, showId: number | null): { episodeId: number | null; showId: number | null; reason: string } {
  // Checked first: a held show's episode IDs are exactly what can't be trusted.
  const held = holdReason(item.grandparentGuid);
  if (held) return { episodeId: null, showId: null, reason: `On hold: ${held}` };
  const tvdb = guidOf(item, 'tvdb');
  if (tvdb) {
    const hit = db.prepare(`SELECT e.id, e.show_id FROM episode_ids i JOIN episodes e ON e.id = i.episode_id WHERE i.provider = 'tvdb' AND i.external_id = ?`).get(tvdb) as { id: number; show_id: number } | undefined;
    if (hit) {
      if (showId !== null && hit.show_id !== showId) return { episodeId: null, showId, reason: 'Episode ID points at a different show' };
      return { episodeId: hit.id, showId: hit.show_id, reason: '' };
    }
  }
  if (showId === null) return { episodeId: null, showId: null, reason: 'Show not in the tracker' };

  const show = db.prepare('SELECT metadata_state, trust_numbering FROM shows WHERE id = ?').get(showId) as { metadata_state: string; trust_numbering: number };
  if (show.metadata_state !== 'ok' && show.metadata_state !== 'not_found') return { episodeId: null, showId, reason: 'Show needs review or has no episode list yet' };

  const season = item.parentIndex;
  const number = item.index;
  if (season === undefined || number === undefined) return { episodeId: null, showId, reason: 'Plex has no season or episode number' };

  const slot = db.prepare('SELECT id, air_date FROM episodes WHERE show_id = ? AND season = ? AND number = ? AND orphaned = 0').get(showId, season, number) as { id: number; air_date: string | null } | undefined;
  if (slot) {
    const aired = item.originallyAvailableAt;
    if (!show.trust_numbering && aired && slot.air_date && daysApart(aired, slot.air_date) > MAX_AIR_DATE_DRIFT_DAYS) {
      return { episodeId: null, showId, reason: `Aired ${aired} in Plex, ${slot.air_date} in TVmaze` };
    }
    if (tvdb) db.prepare(`INSERT OR IGNORE INTO episode_ids (episode_id, provider, external_id) VALUES (?, 'tvdb', ?)`).run(slot.id, tvdb);
    return { episodeId: slot.id, showId, reason: '' };
  }
  if (season === 0 && item.originallyAvailableAt) {
    // TVmaze files specials inside regular seasons with no number; only a unique date links one.
    const candidates = db.prepare(`SELECT id FROM episodes WHERE show_id = ? AND kind = 'special' AND number IS NULL AND orphaned = 0 AND air_date = ?`).pluck().all(showId, item.originallyAvailableAt) as number[];
    if (candidates.length === 1) return { episodeId: candidates[0], showId, reason: '' };
  }
  return { episodeId: null, showId, reason: `No S${season}E${number} in this show's episode list` };
}

const rawRef = (item: PlexEpisode, showTitle?: string) => ({
  ratingKey: item.ratingKey,
  guid: item.guid,
  show: showTitle ?? item.grandparentTitle,
  season: item.parentIndex,
  number: item.index,
  title: item.title,
  aired: item.originallyAvailableAt,
  guids: item.Guid?.map((g) => g.id),
  showRatingKey: item.grandparentRatingKey,
});

const toIso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();
const watchKey = (episodeId: number, viewedAt: number) => `${config.plexAccountId}:${episodeId}:${viewedAt}`;

/** Record one play: as a watch if it can be placed, otherwise kept in the unmatched list. */
function recordPlay(item: PlexEpisode, viewedAt: number, showId: number | null, reasonIfNoShow: string): 'added' | 'known' | 'unmatched' {
  const match = matchEpisode(item, showId);
  const sourceKey = `${item.guid ?? item.ratingKey}:${viewedAt}`;
  const prior = db.prepare(`SELECT status, episode_id FROM unmatched_watches WHERE source = 'plex' AND source_key = ?`).get(sourceKey) as { status: string; episode_id: number | null } | undefined;
  if (prior?.status === 'dismissed') return 'known';
  // Your own assignment beats automatic matching.
  const episodeId = prior?.episode_id ?? match.episodeId;
  if (episodeId !== null) {
    const added = addExternalWatch({ episodeId, source: 'plex', key: watchKey(episodeId, viewedAt), occurredAt: toIso(viewedAt), raw: rawRef(item) });
    if (prior) db.prepare(`UPDATE unmatched_watches SET status = 'matched', episode_id = ?, updated_at = ? WHERE source = 'plex' AND source_key = ?`).run(episodeId, nowIso(), sourceKey);
    return added ? 'added' : 'known';
  }
  const reason = match.showId === null && reasonIfNoShow && !match.reason.startsWith('On hold') ? reasonIfNoShow : match.reason;
  db.prepare(`INSERT INTO unmatched_watches (source, source_key, show_id, reason, occurred_at_utc, payload, created_at, updated_at)
      VALUES ('plex', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_key) DO UPDATE SET show_id = excluded.show_id, reason = excluded.reason, payload = excluded.payload, updated_at = excluded.updated_at`)
    .run(sourceKey, match.showId, reason, toIso(viewedAt), JSON.stringify({ item }), nowIso(), nowIso());
  return 'unmatched';
}

/** Assign an unmatched watch by hand. The watch is recorded under its original date. */
export function assignUnmatched(id: number, episodeId: number): boolean {
  return db.transaction(() => {
    const row = db.prepare(`SELECT source, source_key, occurred_at_utc, payload FROM unmatched_watches WHERE id = ?`).get(id) as { source: 'plex' | 'trakt'; source_key: string; occurred_at_utc: string | null; payload: string } | undefined;
    if (!row || !db.prepare('SELECT 1 FROM episodes WHERE id = ?').get(episodeId)) return false;
    const viewedAt = row.occurred_at_utc ? Date.parse(row.occurred_at_utc) / 1000 : 0;
    const { item } = JSON.parse(row.payload) as { item: PlexEpisode };
    addExternalWatch({ episodeId, source: row.source, key: `${config.plexAccountId}:${episodeId}:${viewedAt}`, occurredAt: row.occurred_at_utc, raw: { ...rawRef(item), assignedByHand: true } });
    db.prepare(`UPDATE unmatched_watches SET status = 'matched', episode_id = ?, updated_at = ? WHERE id = ?`).run(episodeId, nowIso(), id);
    return true;
  })();
}

/**
 * Send a group of unplaced watches to another show, by the same season and episode number.
 * Rows with no such episode there stay open, so nothing is forced.
 */
export function bulkAssign(ids: number[], showId: number): { assigned: number; skipped: number } {
  return db.transaction(() => {
    const row = db.prepare(`SELECT payload FROM unmatched_watches WHERE id = ? AND status = 'open'`).pluck();
    const slot = db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season = ? AND number = ? AND orphaned = 0').pluck();
    let assigned = 0;
    let skipped = 0;
    for (const id of ids) {
      const payload = row.get(id) as string | undefined;
      if (!payload) {
        skipped++;
        continue;
      }
      const { item } = JSON.parse(payload) as { item: PlexEpisode };
      const episodeId = slot.get(showId, item.parentIndex, item.index) as number | undefined;
      if (episodeId !== undefined && assignUnmatched(id, episodeId)) assigned++;
      else skipped++;
    }
    return { assigned, skipped };
  })();
}

/**
 * Full reconciliation. Merges only: Plex losing a file, or showing an episode as unwatched,
 * never changes history. "Watched" means viewCount > 0, because Plex keeps lastViewedAt on
 * episodes that have since been marked unwatched there.
 */
export async function syncPlex() {
  const { MediaContainer: lib } = await get<{ MediaContainer: { Directory?: { key: string; type: string }[] } }>('/library/sections');
  const sections = (lib.Directory ?? []).filter((d) => d.type === 'show');
  const shows: PlexShow[] = [];
  const episodes: PlexEpisode[] = [];
  const plays = new Map<string, Set<number>>();
  // Everything is read before anything is written, so a failure part-way changes nothing.
  for (const s of sections) {
    shows.push(...(await getAll<PlexShow>(`/library/sections/${s.key}/all?type=2&includeGuids=1`)));
    episodes.push(...(await getAll<PlexEpisode>(`/library/sections/${s.key}/all?type=4&includeGuids=1`)));
    const history = await getAll<{ ratingKey?: string; viewedAt?: number }>(`/status/sessions/history/all?accountID=${config.plexAccountId}&librarySectionID=${s.key}`);
    for (const h of history) {
      if (!h.ratingKey || !h.viewedAt) continue;
      const set = plays.get(h.ratingKey);
      if (set) set.add(h.viewedAt);
      else plays.set(h.ratingKey, new Set([h.viewedAt]));
    }
  }
  const known = db.prepare('SELECT COUNT(*) FROM episodes WHERE in_plex = 1').pluck().get() as number;
  if (episodes.length === 0 && known > 0) throw new Error(`Plex returned no episodes but ${known} were known; changing nothing`);

  const watched = episodes.filter((e) => (e.viewCount ?? 0) > 0 && e.lastViewedAt);
  const showByKey = new Map(shows.map((s) => [s.ratingKey, s]));
  const lookups = new Map<string, ShowLookup>();
  db.transaction(() => {
    for (const s of shows) lookups.set(s.ratingKey, findShow(s));
  })();

  let showsAdded = 0;
  for (const key of new Set(watched.map((e) => e.grandparentRatingKey ?? ''))) {
    const s = showByKey.get(key);
    if (!s || lookups.get(key)?.showId != null) continue;
    if (lookups.get(key)?.reason !== 'Show not in the tracker') continue;
    const id = await addMissingShow(s);
    if (id !== null) {
      lookups.set(key, { showId: id, reason: '' });
      showsAdded++;
    }
  }

  const counts = { sections: sections.length, episodes: episodes.length, watched: watched.length, showsAdded, added: 0, known: 0, unmatched: 0, inPlex: 0, retried: 0 };
  db.transaction(() => {
    db.prepare('UPDATE episodes SET in_plex = 0 WHERE in_plex = 1').run();
    const setInPlex = db.prepare('UPDATE episodes SET in_plex = 1 WHERE id = ?');
    const assignedEpisode = db.prepare(`SELECT episode_id FROM unmatched_watches WHERE source = 'plex' AND status = 'matched' AND source_key LIKE ? LIMIT 1`).pluck();
    for (const e of episodes) {
      const look = lookups.get(e.grandparentRatingKey ?? '');
      const m = matchEpisode(e, look?.showId ?? null);
      // An episode you assigned by hand is available through that same Plex item.
      const assigned = m.episodeId ?? (assignedEpisode.get(`${e.guid ?? e.ratingKey}:%`) as number | undefined) ?? null;
      if (assigned !== null) {
        setInPlex.run(assigned);
        counts.inPlex++;
      }
    }
    for (const e of watched) {
      const look = lookups.get(e.grandparentRatingKey ?? '');
      const times = new Set(plays.get(e.ratingKey) ?? []);
      times.add(e.lastViewedAt!);
      for (const t of times) counts[recordPlay(e, t, look?.showId ?? null, look?.reason ?? 'Show not in the tracker')]++;
    }
    // Watches kept from earlier runs, including items Plex no longer has.
    const open = db.prepare(`SELECT source_key, occurred_at_utc, payload, show_id FROM unmatched_watches WHERE source = 'plex' AND status = 'open'`).all() as { source_key: string; occurred_at_utc: string; payload: string; show_id: number | null }[];
    for (const row of open) {
      const { item } = JSON.parse(row.payload) as { item: PlexEpisode };
      if (recordPlay(item, Date.parse(row.occurred_at_utc) / 1000, row.show_id, '') !== 'unmatched') counts.retried++;
    }
  })();
  counts.unmatched = db.prepare(`SELECT COUNT(*) FROM unmatched_watches WHERE source = 'plex' AND status = 'open'`).pluck().get() as number;
  return counts;
}

export interface PlexWebhook {
  event?: string;
  Account?: { id?: number };
  Metadata?: { type?: string; ratingKey?: string };
}

/** Plex posts multipart/form-data, with JSON in a "payload" part and sometimes a thumbnail. */
export function parseWebhook(body: Buffer, contentType: string): PlexWebhook | null {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
  if (!boundary) return null;
  const nameAt = body.indexOf('name="payload"');
  if (nameAt < 0) return null;
  const start = body.indexOf('\r\n\r\n', nameAt);
  if (start < 0) return null;
  const end = body.indexOf(`\r\n--${boundary}`, start);
  try {
    return JSON.parse(body.subarray(start + 4, end < 0 ? undefined : end).toString('utf8')) as PlexWebhook;
  } catch {
    return null;
  }
}

/**
 * The webhook is only a prompt: the watch details are re-read from Plex, so it records the
 * same key reconciliation would and a spoofed or repeated call can't invent a date.
 */
export async function handleWebhook(hook: PlexWebhook): Promise<'ignored' | 'added' | 'known' | 'unmatched' | 'not_watched'> {
  if (hook.event !== 'media.scrobble' || hook.Metadata?.type !== 'episode' || !hook.Metadata.ratingKey) return 'ignored';
  if (hook.Account?.id !== config.plexAccountId) return 'ignored';
  const key = encodeURIComponent(hook.Metadata.ratingKey);
  const { MediaContainer: m } = await get<{ MediaContainer: { Metadata?: PlexEpisode[] } }>(`/library/metadata/${key}?includeGuids=1`);
  const item = m.Metadata?.[0];
  if (!item?.viewCount || !item.lastViewedAt) return 'not_watched'; // reconciliation picks it up
  const { MediaContainer: g } = await get<{ MediaContainer: { Metadata?: PlexShow[] } }>(`/library/metadata/${encodeURIComponent(item.grandparentRatingKey ?? '')}?includeGuids=1`);
  const show = g.Metadata?.[0];
  let look: ShowLookup = show ? db.transaction(() => findShow(show))() : { showId: null, reason: 'Show not in the tracker' };
  if (show && look.showId === null && look.reason === 'Show not in the tracker') {
    const id = await addMissingShow(show);
    if (id !== null) look = { showId: id, reason: '' };
  }
  return db.transaction(() => {
    const result = recordPlay(item, item.lastViewedAt!, look.showId, look.reason);
    const m2 = matchEpisode(item, look.showId);
    if (m2.episodeId !== null) db.prepare('UPDATE episodes SET in_plex = 1 WHERE id = ?').run(m2.episodeId);
    return result;
  })();
}
