// Runs against fake Sonarr/TVmaze servers and a throwaway database (ZZTEST data only).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const day = 86400000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
const date = (offsetDays: number) => iso(offsetDays).slice(0, 10);

type TvEp = { id: number; name: string; season: number; number: number | null; type: string; airdate: string; airstamp: string; summary: string | null };
const tvEp = (id: number, season: number, number: number | null, offset: number, type = 'regular'): TvEp =>
  ({ id, name: `ZZTEST ep ${id}`, season, number, type, airdate: date(offset), airstamp: iso(offset), summary: '<p>Fish &amp; chips</p>' });

const fake = {
  sonarrDown: false,
  series: [] as Record<string, unknown>[],
  sonarrEpisodes: {} as Record<string, Record<string, unknown>[]>,
  shows: {} as Record<string, Record<string, unknown>>,
  episodes: {} as Record<string, TvEp[]>,
  byTvdb: {} as Record<string, string>,
};

const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith('/api/v3/')) {
    if (fake.sonarrDown) return json({}, 503);
    if (req.headers['x-api-key'] !== 'test-key') return json({}, 401);
    if (url.pathname === '/api/v3/series') return json(fake.series);
    if (url.pathname === '/api/v3/episode') return json(fake.sonarrEpisodes[url.searchParams.get('seriesId')!] ?? []);
    if (url.pathname === '/api/v3/system/status') return json({ version: 'test' });
  }
  if (url.pathname === '/lookup/shows') {
    const id = fake.byTvdb[url.searchParams.get('thetvdb') ?? ''];
    return id ? json(fake.shows[id]) : json({}, 404);
  }
  if (url.pathname === '/updates/shows') {
    return json(Object.fromEntries(Object.entries(fake.shows).map(([k, v]) => [k, v.updated])));
  }
  const m = /^\/shows\/(\d+)(\/episodes)?$/.exec(url.pathname);
  if (m && fake.shows[m[1]]) return json(m[2] ? fake.episodes[m[1]] : fake.shows[m[1]]);
  return json({}, 404);
});

const makeShow = (id: number, tvdb: number, status = 'Running') => {
  fake.shows[id] = { id, name: `ZZTEST Show ${id}`, status, updated: 1, summary: '<p>x</p>', externals: { thetvdb: tvdb, imdb: `tt${id}`, tvrage: null } };
  fake.byTvdb[tvdb] = String(id);
};

let db: typeof import('../db.js').db;
let svc: {
  addShow: typeof import('../services/tvmaze.js').addShow;
  refreshShow: typeof import('../services/tvmaze.js').refreshShow;
  syncMetadata: typeof import('../services/tvmaze.js').syncMetadata;
  syncSonarr: typeof import('../services/sonarr.js').syncSonarr;
  setWatched: typeof import('../services/events.js').setWatched;
  correctWatchDate: typeof import('../services/events.js').correctWatchDate;
  episodesForShow: typeof import('../services/progress.js').episodesForShow;
  computeProgress: typeof import('../services/progress.js').computeProgress;
  dashboard: typeof import('../services/progress.js').dashboard;
};

const showIdOf = (tvmaze: number) =>
  db.prepare(`SELECT show_id FROM show_ids WHERE provider = 'tvmaze' AND external_id = ?`).pluck().get(String(tvmaze)) as number;
const epOf = (showId: number, season: number, number: number) =>
  svc.episodesForShow(showId).find((e) => e.season === season && e.number === number && !e.orphaned)!;
const count = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'zztest-'));
  process.env.SONARR_URL = base;
  process.env.SONARR_API_KEY = 'test-key';
  process.env.TVMAZE_URL = base;
  process.env.TVMAZE_GAP_MS = '0';
  process.env.HTTP_RETRIES = '0';
  const dbm = await import('../db.js');
  dbm.migrate();
  db = dbm.db;
  const tv = await import('../services/tvmaze.js');
  const so = await import('../services/sonarr.js');
  const ev = await import('../services/events.js');
  const pr = await import('../services/progress.js');
  svc = { addShow: tv.addShow, refreshShow: tv.refreshShow, syncMetadata: tv.syncMetadata, syncSonarr: so.syncSonarr, setWatched: ev.setWatched, correctWatchDate: ev.correctWatchDate, episodesForShow: pr.episodesForShow, computeProgress: pr.computeProgress, dashboard: pr.dashboard };
});

after(() => {
  server.close();
  db.close();
});

test('adding a show manually gives browsable episodes and adding again makes no duplicate', async () => {
  makeShow(100, 9100);
  fake.episodes[100] = [tvEp(1001, 1, 1, -30), tvEp(1002, 1, 2, -20)];
  const first = await svc.addShow(100);
  assert.equal(first.created, true);
  const second = await svc.addShow(100);
  assert.equal(second.created, false);
  assert.equal(second.showId, first.showId);
  assert.equal(count('SELECT COUNT(*) FROM shows'), 1);
  const eps = svc.episodesForShow(first.showId);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].overview, 'Fish & chips');
});

test('a Sonarr show appears as Discovered, off the dashboard; a re-run adds nothing', async () => {
  makeShow(200, 9200, 'Ended');
  fake.episodes[200] = [tvEp(2001, 1, 1, -30), tvEp(2002, 1, 2, -20), tvEp(2003, 1, 3, -10)];
  fake.series = [{ id: 5, title: 'ZZTEST Show 200', tvdbId: 9200, imdbId: 'tt200', monitored: true }];
  fake.sonarrEpisodes[5] = [
    { id: 51, seasonNumber: 1, episodeNumber: 1, tvdbId: 777, hasFile: true, monitored: true, airDate: date(-30) },
    { id: 52, seasonNumber: 1, episodeNumber: 2, hasFile: false, monitored: true, airDate: date(-20) },
  ];
  await svc.syncSonarr();
  await svc.syncMetadata();
  const id = showIdOf(200);
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id) as { tracking_state: string; in_sonarr: number; status: string };
  assert.equal(show.tracking_state, 'discovered');
  assert.equal(show.in_sonarr, 1);
  assert.equal(show.status, 'Ended');
  const dash = svc.dashboard();
  assert.ok(!Object.values(dash).flat().some((s) => s.id === id), 'discovered shows stay off the dashboard');
  assert.equal(epOf(id, 1, 1).has_file, 1);
  assert.equal(epOf(id, 1, 2).has_file, 0);
  assert.equal(epOf(id, 1, 1).state, null, 'downloaded does not mean watched');

  const before = [count('SELECT COUNT(*) FROM shows'), count('SELECT COUNT(*) FROM episodes')];
  await svc.syncSonarr();
  await svc.syncMetadata();
  assert.deepEqual([count('SELECT COUNT(*) FROM shows'), count('SELECT COUNT(*) FROM episodes')], before);
});

test('deleting a file, then removing the series from Sonarr, keeps the show and its history', async () => {
  const id = showIdOf(200);
  svc.setWatched([epOf(id, 1, 1).id], true);
  fake.sonarrEpisodes[5][0].hasFile = false;
  await svc.syncSonarr();
  assert.equal(epOf(id, 1, 1).has_file, 0);
  assert.equal(epOf(id, 1, 1).state, 'watched');

  fake.series = [{ id: 6, title: 'ZZTEST other', tvdbId: 9999 }];
  await svc.syncSonarr();
  const show = db.prepare('SELECT in_sonarr, sonarr_removed_at FROM shows WHERE id = ?').get(id) as { in_sonarr: number; sonarr_removed_at: string };
  assert.equal(show.in_sonarr, 0);
  assert.ok(show.sonarr_removed_at);
  assert.equal(epOf(id, 1, 1).state, 'watched');
  assert.equal(svc.computeProgress(svc.episodesForShow(id)).lastWatched?.number, 1, 'still shows where I left off');
});

test('an empty list from Sonarr changes nothing', async () => {
  const known = count('SELECT COUNT(*) FROM shows WHERE in_sonarr = 1');
  fake.series = [];
  await assert.rejects(svc.syncSonarr(), /changing nothing/);
  assert.equal(count('SELECT COUNT(*) FROM shows WHERE in_sonarr = 1'), known);
});

test('with Sonarr offline, syncs fail cleanly and the app still answers', async () => {
  const before = count('SELECT COUNT(*) FROM watch_events');
  fake.sonarrDown = true;
  await assert.rejects(svc.syncSonarr());
  fake.sonarrDown = false;
  assert.equal(count('SELECT COUNT(*) FROM watch_events'), before);
  assert.ok(svc.dashboard());
});

test('specials and unaired episodes stay out of progress; skipped episodes show separately', async () => {
  makeShow(300, 9300);
  fake.episodes[300] = [
    tvEp(3001, 1, 1, -90), tvEp(3002, 2, 3, -60), tvEp(3003, 2, 4, -50), tvEp(3004, 2, 5, -40), tvEp(3005, 2, 6, -30),
    tvEp(3006, 2, null, -35, 'significant_special'),
    tvEp(3007, 3, 1, 10),
  ];
  const { showId } = await svc.addShow(300);
  const p0 = svc.computeProgress(svc.episodesForShow(showId));
  assert.equal(p0.aired, 5, 'special and unaired excluded');
  assert.equal(p0.nextToAir?.season, 3);

  svc.setWatched([epOf(showId, 1, 1).id, epOf(showId, 2, 3).id, epOf(showId, 2, 5).id], true);
  const p = svc.computeProgress(svc.episodesForShow(showId));
  assert.equal(p.watched, 3);
  assert.equal(p.percent, 60);
  assert.equal(p.nextToWatch?.number, 4, 'next to watch is the skipped S02E04');
  assert.equal(p.nextAfterLast?.number, 6, 'next after last watch is S02E06');
  assert.ok(p.lastWatched);
});

test('a manual unwatch survives repeated resyncs, and old external records cannot undo it', async () => {
  const id = showIdOf(300);
  const ep = epOf(id, 1, 1);
  svc.setWatched([ep.id], false);
  await svc.refreshShow(id);
  assert.equal(epOf(id, 1, 1).state, 'unwatched');

  const insert = db.prepare(`INSERT INTO watch_events (episode_id, kind, source, occurred_at_utc, date_quality, precedence_at, source_event_key, raw_ref, recorded_at)
    VALUES (?, 'watched', 'plex', ?, ?, ?, ?, '{}', ?)`);
  insert.run(ep.id, iso(-5), 'exact', iso(-5), 'old-record', iso(0));
  assert.equal(epOf(id, 1, 1).state, 'unwatched', 'an older dated record loses');
  insert.run(ep.id, null, 'unknown', '', 'undated-record', iso(0));
  assert.equal(epOf(id, 1, 1).state, 'unwatched', 'an undated record loses');
  assert.throws(() => insert.run(ep.id, iso(-5), 'exact', iso(-5), 'old-record', iso(0)), /UNIQUE/, 'a repeated import key is rejected');
  insert.run(ep.id, iso(1), 'exact', iso(1), 'new-playback', iso(1));
  assert.equal(epOf(id, 1, 1).state, 'watched', 'a genuinely newer playback wins');
});

test('a backdated manual watch still beats an earlier unwatch; correcting a date counts one watch', async () => {
  const id = showIdOf(300);
  const ep = epOf(id, 2, 6);
  svc.setWatched([ep.id], true);
  svc.setWatched([ep.id], false);
  const backdated = iso(-400);
  svc.setWatched([ep.id], true, { mode: 'date', at: backdated });
  assert.equal(epOf(id, 2, 6).state, 'watched');
  assert.equal(epOf(id, 2, 6).occurred_at_utc, backdated);

  const at = iso(-500);
  assert.equal(svc.correctWatchDate(ep.id, at), true);
  assert.equal(epOf(id, 2, 6).occurred_at_utc, at);
  const live = count(`SELECT COUNT(*) FROM watch_events WHERE episode_id = ? AND kind = 'watched' AND duplicate_of IS NULL`, ep.id);
  assert.equal(live, 2, 'first watch plus the corrected one; the backdated original is folded in');
});

test('marking twice adds one event only', () => {
  const id = showIdOf(300);
  const ep = epOf(id, 2, 4);
  assert.equal(svc.setWatched([ep.id], true), 1);
  assert.equal(svc.setWatched([ep.id], true), 0);
});

test('metadata dropping or renumbering an episode keeps its history attached', async () => {
  makeShow(400, 9400);
  fake.episodes[400] = [tvEp(4001, 1, 1, -30), tvEp(4002, 1, 2, -20), tvEp(4003, 1, 3, -10)];
  const { showId } = await svc.addShow(400);
  const a = epOf(showId, 1, 2);
  const b = epOf(showId, 1, 3);
  svc.setWatched([a.id, b.id], true);

  // Swap numbers on 4002 and 4003, drop 4001.
  fake.episodes[400] = [tvEp(4003, 1, 2, -10), tvEp(4002, 1, 3, -20)];
  await svc.refreshShow(showId);
  assert.equal(epOf(showId, 1, 3).id, a.id);
  assert.equal(epOf(showId, 1, 2).id, b.id);
  assert.equal(epOf(showId, 1, 3).state, 'watched');
  const rows = svc.episodesForShow(showId);
  assert.equal(rows.filter((e) => e.orphaned).length, 1);
  assert.equal(rows.length, 3, 'the dropped episode is flagged, not deleted');

  // It comes back under the same TVmaze ID.
  fake.episodes[400].push(tvEp(4001, 1, 1, -30));
  await svc.refreshShow(showId);
  assert.equal(svc.episodesForShow(showId).filter((e) => e.orphaned).length, 0);
});

test('unclear matches go to review rather than being assigned', async () => {
  // Same slot, aired a year apart: a numbering disagreement.
  makeShow(500, 9500);
  fake.episodes[500] = [tvEp(5001, 1, 1, -400)];
  fake.series = [{ id: 7, title: 'ZZTEST Show 500', tvdbId: 9500, monitored: true }];
  fake.sonarrEpisodes[7] = [
    { id: 71, seasonNumber: 1, episodeNumber: 1, hasFile: true, monitored: true, airDate: date(-20) },
    { id: 72, seasonNumber: 1, episodeNumber: 9, hasFile: true, monitored: true, airDate: date(-10) },
  ];
  await svc.syncSonarr();
  await svc.syncMetadata();
  const id = showIdOf(500);
  assert.equal(epOf(id, 1, 1).has_file, 0);
  assert.equal(count(`SELECT COUNT(*) FROM review_queue WHERE type = 'episode_mismatch' AND show_id = ? AND status = 'open'`, id), 1);

  // A show TVmaze doesn't know keeps working from Sonarr's list.
  fake.series.push({ id: 8, title: 'ZZTEST Unknown', tvdbId: 9600, monitored: true });
  fake.sonarrEpisodes[8] = [{ id: 81, seasonNumber: 1, episodeNumber: 1, hasFile: true, monitored: true, airDate: date(-5) }];
  await svc.syncSonarr();
  await svc.syncMetadata();
  const unknown = db.prepare(`SELECT show_id FROM show_ids WHERE provider = 'tvdb' AND external_id = '9600'`).pluck().get() as number;
  assert.equal(epOf(unknown, 1, 1).has_file, 1);
  assert.equal(count(`SELECT COUNT(*) FROM review_queue WHERE type = 'show_not_on_tvmaze' AND show_id = ?`, unknown), 1);

  // TVmaze's IDs contradicting stored ones blocks the merge.
  makeShow(600, 9700);
  fake.episodes[600] = [tvEp(6001, 1, 1, -5)];
  const { showId } = await svc.addShow(600);
  (fake.shows[600].externals as { thetvdb: number }).thetvdb = 12345;
  await svc.refreshShow(showId);
  const state = db.prepare('SELECT metadata_state FROM shows WHERE id = ?').pluck().get(showId);
  assert.equal(state, 'needs_review');
});

test('history tables cannot be emptied through a show delete', () => {
  assert.throws(() => db.prepare('DELETE FROM shows').run(), /FOREIGN KEY/);
});
