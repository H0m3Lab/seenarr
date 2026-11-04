// Trakt export import: ZZTEST data in a throwaway data dir, fake TVmaze.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tvShows: Record<string, unknown> = {
  '801': { id: 801, name: 'ZZTEST Missing Show', status: 'Ended', updated: 1, summary: null, externals: { thetvdb: 88001, imdb: 'tt8801', tvrage: null } },
};
const tvEpisodes: Record<string, unknown[]> = {
  '801': [{ id: 80101, name: 'One', season: 1, number: 1, type: 'regular', airdate: '2020-01-01', airstamp: '2020-01-01T12:00:00Z', summary: null }],
};
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const json = (b: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (url.pathname === '/lookup/shows') return url.searchParams.get('thetvdb') === '88001' ? json(tvShows['801']) : json({}, 404);
  const m = /^\/shows\/(\d+)(\/episodes)?$/.exec(url.pathname);
  if (m && tvShows[m[1]]) return json(m[2] ? tvEpisodes[m[1]] : tvShows[m[1]]);
  json({}, 404);
});

let db: typeof import('../db.js').db;
let trakt: typeof import('../services/trakt.js');
let identity: typeof import('../services/identity.js');
let events: typeof import('../services/events.js');
let dataDir = '';
const stateOf = (id: number) => db.prepare('SELECT state FROM episode_state WHERE episode_id = ?').pluck().get(id) as string | undefined;

const play = (id: number, at: string, show: { title: string; tvdb: number; trakt: number }, s: number, n: number, epTvdb?: number) => ({
  id, watched_at: at, action: 'watch', type: 'episode',
  episode: { season: s, number: n, title: `Ep ${n}`, ids: { trakt: id * 10, tvdb: epTvdb ?? null } },
  show: { title: show.title, year: 2020, ids: { trakt: show.trakt, tvdb: show.tvdb, imdb: null, tmdb: null } },
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  dataDir = mkdtempSync(path.join(tmpdir(), 'zztest-trakt-'));
  mkdirSync(path.join(dataDir, 'imports', 'trakt-zztest'), { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.TVMAZE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TVMAZE_GAP_MS = '0';
  process.env.HTTP_RETRIES = '0';
  trakt = await import('../services/trakt.js');
  db = (await import('../db.js')).db;
  identity = await import('../services/identity.js');
  events = await import('../services/events.js');
});

after(() => {
  server.close();
  db.close();
});

test('Trakt plays match by ID, bulk clicks get no date, deleted shows stay out, unwatches win, re-runs add nothing', async () => {
  const here = identity.createShow('ZZTEST Here', 'discovered');
  identity.addShowIds(here, { tvdb: 77001 });
  const ins = db.prepare(`INSERT INTO episodes (show_id, season, number, kind, title, air_date, created_at, updated_at) VALUES (?, ?, ?, 'regular', ?, '2020-01-01', 'x', 'x')`);
  const ep: number[] = [];
  for (let n = 1; n <= 30; n++) ep[n] = Number(ins.run(here, 1, n, `Ep ${n}`).lastInsertRowid);
  db.prepare(`INSERT INTO episode_ids (episode_id, provider, external_id) VALUES (?, 'tvdb', '990001')`).run(ep[1]);
  events.setWatched([ep[3]], true); // marked, then unmarked here, after its Trakt play
  events.setWatched([ep[3]], false);
  // A show you deleted here must not come back.
  const gone = identity.createShow('ZZTEST Gone', 'discovered');
  identity.addShowIds(gone, { tvdb: 66001 });
  const { deleteShow } = await import('../services/delete.js');
  deleteShow(gone);

  const H = { title: 'ZZTEST Here', tvdb: 77001, trakt: 1 };
  const plays = [
    play(1, '2023-05-01T20:00:00.000Z', H, 9, 9, 990001), // numbering differs, but the episode's TVDB ID is right
    play(2, '2023-05-02T20:00:00.000Z', H, 1, 2),
    play(3, '2023-05-03T20:00:00.000Z', H, 1, 3),
    play(4, '2023-05-04T20:00:00.000Z', H, 1, 99),
    ...Array.from({ length: 26 }, (_, i) => play(100 + i, '2025-01-01T11:15:00.000Z', H, 1, i + 4 > 30 ? 30 : i + 4)),
    play(200, '2023-01-01T20:00:00.000Z', { title: 'ZZTEST Gone', tvdb: 66001, trakt: 2 }, 1, 1),
    play(300, '2023-01-02T20:00:00.000Z', { title: 'ZZTEST Missing Show', tvdb: 88001, trakt: 3 }, 1, 1),
    { id: 400, watched_at: '2023-01-03T20:00:00.000Z', action: 'watch', type: 'movie' },
  ];
  writeFileSync(path.join(dataDir, 'imports', 'trakt-zztest', 'watched-history-1.json'), JSON.stringify(plays));

  const pv = trakt.previewTrakt('trakt-zztest');
  assert.equal(pv.movies, 1);
  assert.equal(pv.toAdd, 29, 'S1E1 by TVDB id, E2, E3, and 26 bulk plays');
  assert.equal(pv.datedUnknown, 26);
  assert.deepEqual(pv.deleted, [{ show: 'ZZTEST Gone', plays: 1 }]);
  assert.deepEqual(pv.missing.map((m) => m.title), ['ZZTEST Missing Show']);
  assert.equal(pv.unplaced.length, 1, 'S1E99 does not exist');
  assert.equal(db.prepare(`SELECT COUNT(*) FROM watch_events WHERE source = 'trakt'`).pluck().get(), 0, 'preview writes nothing');

  const r = await trakt.applyTrakt('trakt-zztest');
  assert.equal(r.showsAdded.length, 1, 'the missing show is added by its TVDB ID');
  assert.equal(r.added, 30, '29 plus the missing show\'s play');
  assert.equal(stateOf(ep[1]), 'watched');
  assert.equal(stateOf(ep[3]), 'unwatched', 'your later unwatch outranks an older Trakt play');
  const bulk = db.prepare(`SELECT date_quality, occurred_at_utc FROM watch_events WHERE source = 'trakt' AND source_event_key = 'history:100'`).get() as { date_quality: string; occurred_at_utc: string | null };
  assert.deepEqual(bulk, { date_quality: 'unknown', occurred_at_utc: null });
  assert.equal(db.prepare(`SELECT COUNT(*) FROM shows WHERE title = 'ZZTEST Gone'`).pluck().get(), 0);
  assert.equal(db.prepare(`SELECT external_id FROM show_ids WHERE show_id = ? AND provider = 'trakt'`).pluck().get(here), '1', 'Trakt ID remembered');

  assert.equal((await trakt.applyTrakt('trakt-zztest')).added, 0, 'second run adds nothing');
});
