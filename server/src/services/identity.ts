import { db, nowIso } from '../db.js';

export type Provider = 'tvmaze' | 'tvdb' | 'imdb' | 'tmdb' | 'tvrage' | 'sonarr' | 'plex' | 'trakt';
export type IdSet = Partial<Record<Provider, string | number | null | undefined>>;

export const sortTitle = (t: string) => t.replace(/^(the|a|an)\s+/i, '').toLowerCase();

/** Non-empty IDs only; Sonarr uses 0 and '' for "none". */
export function cleanIds(ids: IdSet): [Provider, string][] {
  return Object.entries(ids)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
    .map(([k, v]) => [k as Provider, String(v)]);
}

/** Every show any of these IDs points to. More than one means the sources disagree. */
export function findShowsByIds(ids: IdSet): number[] {
  const q = db.prepare('SELECT show_id FROM show_ids WHERE provider = ? AND external_id = ?').pluck();
  const found = new Set<number>();
  for (const [p, v] of cleanIds(ids)) {
    const id = q.get(p, v) as number | undefined;
    if (id !== undefined) found.add(id);
  }
  return [...found];
}

export function getShowIds(showId: number): Partial<Record<Provider, string>> {
  const rows = db.prepare('SELECT provider, external_id FROM show_ids WHERE show_id = ?').all(showId) as { provider: Provider; external_id: string }[];
  return Object.fromEntries(rows.map((r) => [r.provider, r.external_id]));
}

/** Attach IDs to a show. Returns the conflicts; a conflicting ID is never overwritten. */
export function addShowIds(showId: number, ids: IdSet, ignoreDifferences = false): string[] {
  const owner = db.prepare('SELECT show_id FROM show_ids WHERE provider = ? AND external_id = ?').pluck();
  const mine = db.prepare('SELECT external_id FROM show_ids WHERE show_id = ? AND provider = ?').pluck();
  const insert = db.prepare('INSERT INTO show_ids (show_id, provider, external_id) VALUES (?, ?, ?)');
  const conflicts: string[] = [];
  for (const [p, v] of cleanIds(ids)) {
    const ownerId = owner.get(p, v) as number | undefined;
    const existing = mine.get(showId, p) as string | undefined;
    if (ownerId === showId) continue;
    if (ownerId !== undefined) conflicts.push(`${p} ${v} already belongs to show ${ownerId}`);
    else if (existing !== undefined) {
      // Plex GUIDs differ per library item, and a reviewed show has been confirmed by you.
      if (!ignoreDifferences && p !== 'plex') conflicts.push(`${p} is ${existing} here but the source says ${v}`);
    } else insert.run(showId, p, v);
  }
  return conflicts;
}

export function createShow(title: string, tracking: 'discovered' | 'following'): number {
  const at = nowIso();
  return Number(
    db.prepare(`INSERT INTO shows (title, sort_title, tracking_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(title, sortTitle(title), tracking, at, at).lastInsertRowid,
  );
}

export function openReview(key: string, type: string, showId: number | null, summary: string, payload: unknown) {
  const at = nowIso();
  db.prepare(`
    INSERT INTO review_queue (dedupe_key, type, show_id, summary, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      summary = excluded.summary, payload = excluded.payload, updated_at = excluded.updated_at,
      status = CASE WHEN status = 'closed_auto' THEN 'open' ELSE status END
  `).run(key, type, showId, summary, JSON.stringify(payload), at, at);
}

export function closeReview(key: string) {
  db.prepare(`UPDATE review_queue SET status = 'closed_auto', updated_at = ? WHERE dedupe_key = ? AND status = 'open'`).run(nowIso(), key);
}
