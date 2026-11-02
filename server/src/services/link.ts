import { db, nowIso } from '../db.js';
import { closeReview, openReview } from './identity.js';
import { isAired } from './progress.js';

interface SonarrEp {
  sonarr_id: number;
  season: number;
  number: number;
  tvdb_id: string | null;
  has_file: number;
  monitored: number;
  title: string | null;
  overview: string | null;
  air_at_utc: string | null;
  air_date: string | null;
}

interface Ep {
  id: number;
  season: number;
  number: number | null;
  kind: string;
  air_date: string | null;
  orphaned: number;
}

export const MAX_AIR_DATE_DRIFT_DAYS = 7;

export const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/**
 * Copies Sonarr's availability onto our episodes for one show. Touches availability only,
 * never watch history. Sonarr episodes that can't be matched confidently go to review
 * rather than being assigned.
 */
export function linkSonarr(showId: number) {
  db.transaction(() => {
    const show = db.prepare('SELECT metadata_state, trust_numbering FROM shows WHERE id = ?').get(showId) as { metadata_state: string; trust_numbering: number };
    const sonarr = db.prepare('SELECT * FROM sonarr_episodes WHERE show_id = ?').all(showId) as SonarrEp[];
    const at = nowIso();
    db.prepare('UPDATE episodes SET has_file = 0, sonarr_monitored = 0 WHERE show_id = ? AND (has_file = 1 OR sonarr_monitored = 1)').run(showId);

    const insert = db.prepare(`INSERT INTO episodes (show_id, season, number, kind, title, overview, air_at_utc, air_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const apply = db.prepare('UPDATE episodes SET has_file = ?, sonarr_monitored = ?, updated_at = ? WHERE id = ?');
    const addTvdb = db.prepare(`INSERT OR IGNORE INTO episode_ids (episode_id, provider, external_id) VALUES (?, 'tvdb', ?)`);
    const link = (epId: number, s: SonarrEp) => {
      apply.run(s.has_file, s.monitored, at, epId);
      if (s.tvdb_id) addTvdb.run(epId, s.tvdb_id);
    };

    const eps = () => db.prepare('SELECT id, season, number, kind, air_date, orphaned FROM episodes WHERE show_id = ?').all(showId) as Ep[];
    const current = eps();
    const bySlot = new Map(current.filter((e) => !e.orphaned && e.number !== null).map((e) => [`${e.season}:${e.number}`, e]));
    const makeRow = (s: SonarrEp) =>
      Number(insert.run(showId, s.season, s.number, s.season === 0 ? 'special' : 'regular', s.title, s.overview, s.air_at_utc, s.air_date, at, at).lastInsertRowid);

    // No metadata source for this show: Sonarr's list is the best we have.
    if (show.metadata_state === 'not_found') {
      for (const s of sonarr) {
        const e = bySlot.get(`${s.season}:${s.number}`);
        link(e ? e.id : makeRow(s), s);
      }
      return;
    }
    if (show.metadata_state !== 'ok') return; // wait for metadata before assigning anything

    const mismatches: { sonarr: string; reason: string }[] = [];
    const now = new Date();
    for (const s of sonarr) {
      const label = `S${s.season}E${s.number}`;
      if (s.season === 0) {
        // TVmaze files specials inside regular seasons with no number, so only an
        // unambiguous air-date match links them. Otherwise keep Sonarr's own special row.
        const slot = bySlot.get(`0:${s.number}`);
        const candidates = current.filter((e) => e.kind === 'special' && e.number === null && !e.orphaned && e.air_date && e.air_date === s.air_date);
        if (slot) link(slot.id, s);
        else if (candidates.length === 1) link(candidates[0].id, s);
        else link(makeRow(s), s);
        continue;
      }
      const e = bySlot.get(`${s.season}:${s.number}`);
      if (!e) {
        // An upcoming episode Sonarr lists first isn't a numbering problem; it'll show up.
        if (s.has_file || isAired(s, now)) mismatches.push({ sonarr: label, reason: 'not in TVmaze numbering' });
        continue;
      }
      if (!show.trust_numbering && e.air_date && s.air_date && daysApart(e.air_date, s.air_date) > MAX_AIR_DATE_DRIFT_DAYS) {
        mismatches.push({ sonarr: label, reason: `aired ${s.air_date} in Sonarr, ${e.air_date} in TVmaze` });
        continue;
      }
      link(e.id, s);
    }

    const key = `episode_mismatch:${showId}`;
    if (mismatches.length) {
      openReview(key, 'episode_mismatch', showId, `${mismatches.length} Sonarr episode(s) don't line up with TVmaze`, { mismatches });
    } else {
      closeReview(key);
    }
  })();
}
