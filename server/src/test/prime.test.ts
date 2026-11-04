// Prime Video history import: ZZTEST data in a throwaway data dir, fake TVmaze search.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url?.startsWith('/search/shows') ? '[]' : '{}');
});

let db: typeof import('../db.js').db;
let prime: typeof import('../services/prime.js');
let events: typeof import('../services/events.js');
let identity: typeof import('../services/identity.js');
let dataDir = '';

const count = (sql: string, ...a: unknown[]) => db.prepare(sql).pluck().get(...a) as number;
const stateOf = (id: number) => db.prepare('SELECT state FROM episode_state WHERE episode_id = ?').pluck().get(id) as string | undefined;

function makeShow(title: string, eps: [number, number, string][]) {
  const id = identity.createShow(title, 'discovered');
  const ins = db.prepare(`INSERT INTO episodes (show_id, season, number, kind, title, air_date, created_at, updated_at) VALUES (?, ?, ?, 'regular', ?, '2020-01-01', 'x', 'x')`);
  const ids: Record<string, number> = {};
  for (const [s, n, t] of eps) ids[`${s}x${n}`] = Number(ins.run(id, s, n, t).lastInsertRowid);
  return { id, ids };
}

const writeFile = (entries: unknown[]) => writeFileSync(path.join(dataDir, 'imports', 'zztest.json'), JSON.stringify({ source: 'amazon-prime-video-watch-history', entries }));

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  dataDir = mkdtempSync(path.join(tmpdir(), 'zztest-prime-'));
  mkdirSync(path.join(dataDir, 'imports'));
  process.env.DATA_DIR = dataDir;
  process.env.TVMAZE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TVMAZE_GAP_MS = '0';
  process.env.HTTP_RETRIES = '0';
  prime = await import('../services/prime.js');
  db = (await import('../db.js')).db;
  events = await import('../services/events.js');
  identity = await import('../services/identity.js');
});

after(() => {
  server.close();
  db.close();
});

test('Amazon title formats are cleaned to show + season', () => {
  const p = prime.parseSeriesTitle;
  assert.deepEqual(p('The Night Manager, Season 1'), { show: 'The Night Manager', season: 1 });
  assert.deepEqual(p('The Boys – Season 4'), { show: 'The Boys', season: 4 });
  assert.deepEqual(p('Vikings Season 2'), { show: 'Vikings', season: 2 });
  assert.deepEqual(p('The Bondsman - Season One'), { show: 'The Bondsman', season: 1 });
  assert.deepEqual(p('WHEEL OF TIME, THE (2021) - Season 3'), { show: 'THE WHEEL OF TIME', season: 3 });
  assert.deepEqual(p('Evil S3 - Season 3'), { show: 'Evil', season: 3 });
  assert.deepEqual(p('Cajun Pawn Stars Volume 3'), { show: 'Cajun Pawn Stars', season: 3 });
  assert.deepEqual(p("Tom Clancy's Jack Ryan"), { show: "Tom Clancy's Jack Ryan", season: null });
  assert.deepEqual(p('Gina Brillon: The Floor is Lava (4K UHD)'), { show: 'Gina Brillon: The Floor is Lava', season: null });
  assert.deepEqual(p('Season 3'), { show: '', season: 3 });
  assert.equal(prime.showKey('THE WHEEL OF TIME'), prime.showKey('The Wheel of Time'));
  assert.deepEqual(prime.parseEpisode('Episode 7: Here Comes a Candle to Light You to Bed'), { number: 7, title: 'Here Comes a Candle to Light You to Bed' });
});

test('preview places episodes carefully and adds nothing; apply adds once; re-running adds nothing', async () => {
  const boys = makeShow('ZZTEST The Boys', [[1, 1, 'The Name of the Game'], [1, 2, 'Cherry'], [1, 3, 'Get Some'], [4, 1, 'Department of Dirty Tricks']]);
  const ryan = makeShow("ZZTEST Tom Clancy's Jack Ryan", [[4, 5, 'Wukong'], [4, 6, 'Proof of Concept']]);
  writeFile([
    { date: 'February 1, 2024', title: 'ZZTEST The Boys - Season 1', kind: 'series', episodes: ['Episode 2: Cherry', 'Episode 1: “The Name of the Game”'], gti: 'g1' },
    { date: 'February 1, 2024', title: 'ZZTEST The Boys - Season 1', kind: 'series', episodes: ['Episode 2: Cherry'], gti: 'g1' }, // listed twice by Amazon
    { date: 'February 2, 2024', title: 'ZZTEST The Boys - Season 1', kind: 'series', episodes: ['Episode 3: Some Other Title Entirely'], gti: 'g1' },
    { date: 'July 27, 2024', title: 'ZZTEST The Boys – Season 4', kind: 'series', episodes: ['Episode 1: Department of Dirty Tricks', 'Episode 9: Not Aired Here'], gti: 'g4' },
    { date: 'August 7, 2023', title: "ZZTEST Tom Clancy's Jack Ryan", kind: 'series', episodes: ['Episode 6: Proof of Concept', 'Episode 5: Wukong', 'Episode 2: Unknown Title'], gti: 'g5' },
    { date: 'June 4, 2024', title: 'Episode 0: ZZTEST Trailer', kind: 'movie', episodes: [], gti: 'g6' },
    { date: 'May 13, 2024', title: 'ZZTEST Road House', kind: 'movie', episodes: [], gti: 'g7' },
    { date: 'July 5, 2025', title: 'ZZTEST Blue Ridge: The Series', kind: 'series', episodes: ['Episode 1: Pilot', 'Episode 2: Two'], gti: 'g8' },
    { date: 'March 6, 2025', title: 'Season 3', kind: 'series', episodes: ['Episode 5: Smackdown'], gti: 'g9' },
  ]);
  const before = count('SELECT COUNT(*) FROM watch_events');
  const pv = await prime.previewPrime('zztest.json');
  assert.equal(count('SELECT COUNT(*) FROM watch_events'), before, 'preview writes nothing');
  assert.equal(pv.toAdd, 5, 'Boys S1E1, S1E2, S4E1 by number; Jack Ryan two by title');
  assert.deepEqual(pv.skipped, { movies: 1, trailers: 1, repeats: 1 });
  assert.equal(pv.missing.length, 1);
  assert.equal(pv.missing[0].primeShow, 'ZZTEST Blue Ridge: The Series');
  assert.equal(pv.unplaced.length, 4, 'title disagreement, missing slot, unknown title with no season, nameless show');
  assert.ok(pv.unplaced.some((u) => /not "Some Other Title Entirely"/.test(u.reason)));

  const r = await prime.applyPrime('zztest.json');
  assert.equal(r.added, 5);
  assert.ok(r.backup.startsWith('before-prime-import-'));
  assert.equal(stateOf(boys.ids['1x1']), 'watched');
  assert.equal(stateOf(boys.ids['1x3']), undefined, 'a disagreeing title is not assigned');
  assert.equal(stateOf(ryan.ids['4x6']), 'watched');
  const ev = db.prepare(`SELECT date_quality, occurred_at_utc FROM watch_events WHERE source = 'prime' AND episode_id = ?`).get(boys.ids['1x2']) as { date_quality: string; occurred_at_utc: string };
  assert.equal(ev.date_quality, 'date_only');
  assert.equal(new Date(ev.occurred_at_utc).toLocaleDateString('en-CA'), '2024-02-01');
  assert.equal(db.prepare('SELECT tracking_state FROM shows WHERE id = ?').pluck().get(boys.id), 'following', 'a watched discovered show becomes followed');

  assert.equal((await prime.applyPrime('zztest.json')).added, 0, 'second run adds nothing');
  assert.equal((await prime.previewPrime('zztest.json')).alreadyImported, 5);
});

test('a later manual unwatch beats an older Prime record, and linking a show name places its episodes', async () => {
  const boysId = db.prepare(`SELECT id FROM shows WHERE title = 'ZZTEST The Boys'`).pluck().get() as number;
  const ep = db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season = 1 AND number = 2').pluck().get(boysId) as number;
  events.setWatched([ep], false);
  await prime.applyPrime('zztest.json');
  assert.equal(stateOf(ep), 'unwatched', 'the old import record cannot undo your unwatch');

  const ridge = makeShow('ZZTEST Blue Ridge', [[1, 1, 'Pilot'], [1, 2, 'Two']]);
  prime.linkPrimeShow('ZZTEST Blue Ridge: The Series', ridge.id);
  const pv = await prime.previewPrime('zztest.json');
  assert.equal(pv.missing.length, 0);
  assert.equal(pv.toAdd, 2, 'no season given, but both titles are unique in the linked show');
});
