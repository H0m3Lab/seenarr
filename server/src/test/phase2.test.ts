// Runs against fake Plex/TVmaze servers and a throwaway database (ZZTEST data only).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const day = 86400;
const nowS = Math.floor(Date.now() / 1000);
const date = (offsetDays: number) => new Date((nowS + offsetDays * day) * 1000).toISOString().slice(0, 10);

type Ep = Record<string, unknown> & { ratingKey: string };
const fake = {
  down: false,
  shows: [] as Record<string, unknown>[],
  episodes: [] as Ep[],
  history: [] as Record<string, unknown>[],
  tvShows: {} as Record<string, Record<string, unknown>>,
  tvEpisodes: {} as Record<string, Record<string, unknown>[]>,
  byTvdb: {} as Record<string, string>,
  tokenSeen: '',
};

const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const p = url.pathname;
  if (p === '/lookup/shows') {
    const id = fake.byTvdb[url.searchParams.get('thetvdb') ?? ''];
    return id ? json(fake.tvShows[id]) : json({}, 404);
  }
  if (p === '/updates/shows') return json({});
  const tv = /^\/shows\/(\d+)(\/episodes)?$/.exec(p);
  if (tv) return fake.tvShows[tv[1]] ? json(tv[2] ? fake.tvEpisodes[tv[1]] : fake.tvShows[tv[1]]) : json({}, 404);

  if (fake.down) return json({}, 503);
  fake.tokenSeen = String(req.headers['x-plex-token'] ?? '');
  if (fake.tokenSeen !== 'test-token') return json({}, 401);
  const container = (Metadata: unknown[]) => json({ MediaContainer: { totalSize: Metadata.length, Metadata } });
  const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? 0);
  const paged = (all: unknown[]) => json({ MediaContainer: { totalSize: all.length, Metadata: all.slice(start, start + 1000) } });
  if (p === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', type: 'show' }, { key: '2', type: 'movie' }] } });
  if (p === '/library/sections/1/all') return paged(url.searchParams.get('type') === '2' ? fake.shows : fake.episodes);
  if (p === '/status/sessions/history/all') {
    assert.equal(url.searchParams.get('accountID'), '1');
    return paged(fake.history);
  }
  const meta = /^\/library\/metadata\/(.+)$/.exec(p);
  if (meta) return container([...fake.episodes, ...fake.shows].filter((x) => x.ratingKey === meta[1]));
  return json({}, 404);
});

const plexShow = (key: string, tvdb: number | null, title = `ZZTEST ${key}`) => ({
  ratingKey: key, guid: `plex://show/${key}`, title, Guid: tvdb ? [{ id: `tvdb://${tvdb}` }] : [],
});
const plexEp = (key: string, show: string, season: number, number: number, viewedAt?: number, extra: Record<string, unknown> = {}): Ep => ({
  ratingKey: key, guid: `plex://episode/${key}`, title: `ZZTEST ep ${key}`, parentIndex: season, index: number,
  grandparentRatingKey: show, grandparentTitle: `ZZTEST ${show}`, originallyAvailableAt: date(-30),
  ...(viewedAt ? { viewCount: 1, lastViewedAt: viewedAt } : {}), Guid: [], ...extra,
});
const tvShow = (id: number, tvdb: number) => {
  fake.tvShows[id] = { id, name: `ZZTEST TV ${id}`, status: 'Running', updated: 1, externals: { thetvdb: tvdb, imdb: null, tvrage: null } };
  fake.byTvdb[tvdb] = String(id);
};
const tvEps = (id: number, count: number) => {
  fake.tvEpisodes[id] = Array.from({ length: count }, (_, i) => ({
    id: id * 100 + i + 1, name: `ZZTEST TV ep ${i + 1}`, season: 1, number: i + 1, type: 'regular', airdate: date(-30), airstamp: `${date(-30)}T01:00:00+00:00`,
  }));
};

let db: typeof import('../db.js').db;
let plex: typeof import('../services/plex.js');
let events: typeof import('../services/events.js');
let progress: typeof import('../services/progress.js');
let tvmaze: typeof import('../services/tvmaze.js');

const count = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
const showOf = (tvmazeId: number) => db.prepare(`SELECT show_id FROM show_ids WHERE provider = 'tvmaze' AND external_id = ?`).pluck().get(String(tvmazeId)) as number;
const ep = (showId: number, number: number) => progress.episodesForShow(showId).find((e) => e.season === 1 && e.number === number)!;

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'zztest-')), PLEX_URL: base, PLEX_TOKEN: 'test-token', PLEX_ACCOUNT_ID: '1',
    TVMAZE_URL: base, TVMAZE_GAP_MS: '0', HTTP_RETRIES: '0',
  });
  plex = await import('../services/plex.js');
  events = await import('../services/events.js');
  progress = await import('../services/progress.js');
  tvmaze = await import('../services/tvmaze.js');
  db = (await import('../db.js')).db;
});

after(() => {
  server.close();
  db.close();
});

test('import uses real watched state, keeps every dated play, and a re-run adds nothing', async () => {
  tvShow(10, 1010);
  tvEps(10, 4);
  await tvmaze.addShow(10);
  const id = showOf(10);
  db.prepare(`UPDATE shows SET tracking_state = 'discovered' WHERE id = ?`).run(id);

  fake.shows = [plexShow('s1', 1010)];
  fake.episodes = [
    plexEp('e1', 's1', 1, 1, nowS - 10 * day),
    plexEp('e2', 's1', 1, 2),
    // Plex keeps lastViewedAt after an episode is marked unwatched there. That isn't a watch.
    plexEp('e3', 's1', 1, 3, undefined, { lastViewedAt: nowS - 9 * day }),
  ];
  fake.history = [
    { ratingKey: 'e1', viewedAt: nowS - 10 * day, accountID: 1 },
    { ratingKey: 'e1', viewedAt: nowS - 100 * day, accountID: 1 },
  ];
  const first = await plex.syncPlex();
  assert.equal(first.added, 2);
  assert.equal(ep(id, 1).state, 'watched');
  assert.equal(ep(id, 2).state, null);
  assert.equal(ep(id, 3).state, null, 'a leftover date is not a watch');
  assert.equal(ep(id, 1).in_plex, 1);
  assert.equal(ep(id, 2).in_plex, 1, 'in Plex is separate from watched');
  assert.equal(ep(id, 4).in_plex, 0);
  assert.equal(db.prepare('SELECT tracking_state FROM shows WHERE id = ?').pluck().get(id), 'following', 'watching promotes a discovered show');

  const total = count('SELECT COUNT(*) FROM watch_events');
  const again = await plex.syncPlex();
  assert.equal(again.added, 0);
  assert.equal(count('SELECT COUNT(*) FROM watch_events'), total);
});

test('an old show missing from the tracker is added by external ID', async () => {
  tvShow(20, 2020);
  tvEps(20, 2);
  fake.shows.push(plexShow('s2', 2020));
  fake.episodes.push(plexEp('e20', 's2', 1, 1, nowS - 400 * day));
  await plex.syncPlex();
  const id = showOf(20);
  assert.equal(ep(id, 1).state, 'watched');
  assert.equal(db.prepare('SELECT tracking_state FROM shows WHERE id = ?').pluck().get(id), 'following');
  assert.equal(count('SELECT in_sonarr FROM shows WHERE id = ?', id), 0);
});

test('a show Plex has without any external IDs is never matched by title', async () => {
  const shows = count('SELECT COUNT(*) FROM shows');
  fake.shows.push(plexShow('s3', null, 'ZZTEST TV 10'));
  fake.episodes.push(plexEp('e30', 's3', 1, 1, nowS - 5 * day));
  const r = await plex.syncPlex();
  assert.equal(count('SELECT COUNT(*) FROM shows'), shows);
  assert.ok(r.unmatched >= 1);
  assert.equal(count(`SELECT COUNT(*) FROM unmatched_watches WHERE status = 'open' AND show_id IS NULL`), 1);
});

test('an episode that cannot be placed is kept, retried, and can be assigned by hand with its date', async () => {
  const id = showOf(10);
  const when = nowS - 50 * day;
  fake.episodes.push(plexEp('e9', 's1', 1, 9, when));
  await plex.syncPlex();
  const row = db.prepare(`SELECT id, reason FROM unmatched_watches WHERE source_key LIKE 'plex://episode/e9:%'`).get() as { id: number; reason: string };
  assert.match(row.reason, /No S1E9/);

  // It survives Plex losing the item.
  fake.episodes = fake.episodes.filter((e) => e.ratingKey !== 'e9');
  await plex.syncPlex();
  assert.equal(count(`SELECT COUNT(*) FROM unmatched_watches WHERE id = ? AND status = 'open'`, row.id), 1);

  assert.equal(plex.assignUnmatched(row.id, ep(id, 4).id), true);
  assert.equal(ep(id, 4).state, 'watched');
  assert.equal(ep(id, 4).occurred_at_utc, new Date(when * 1000).toISOString(), 'keeps the original date');
  assert.equal(count(`SELECT COUNT(*) FROM unmatched_watches WHERE id = ? AND status = 'matched'`, row.id), 1);
});

test('air-date disagreement goes to the unmatched list unless you confirmed the numbering', async () => {
  tvShow(30, 3030);
  tvEps(30, 1);
  await tvmaze.addShow(30);
  const id = showOf(30);
  fake.shows.push(plexShow('s4', 3030));
  fake.episodes.push(plexEp('e40', 's4', 1, 1, nowS - 3 * day, { originallyAvailableAt: date(-400) }));
  await plex.syncPlex();
  assert.equal(ep(id, 1).state, null);
  db.prepare('UPDATE shows SET trust_numbering = 1 WHERE id = ?').run(id);
  await plex.syncPlex();
  assert.equal(ep(id, 1).state, 'watched');
});

test('an episode TVDB ID wins over numbering, including when the numbers differ', async () => {
  const id = showOf(20);
  db.prepare(`INSERT INTO episode_ids (episode_id, provider, external_id) VALUES (?, 'tvdb', '555')`).run(ep(id, 2).id);
  fake.episodes.push(plexEp('e21', 's2', 7, 7, nowS - 2 * day, { Guid: [{ id: 'tvdb://555' }] }));
  await plex.syncPlex();
  assert.equal(ep(id, 2).state, 'watched');
});

test('a manual unwatch survives reconciliation until a genuinely new playback', async () => {
  const id = showOf(10);
  events.setWatched([ep(id, 1).id], false);
  await plex.syncPlex();
  await plex.syncPlex();
  assert.equal(ep(id, 1).state, 'unwatched', 'Plex still saying watched changes nothing');

  fake.episodes.find((e) => e.ratingKey === 'e1')!.lastViewedAt = nowS + 60;
  await plex.syncPlex();
  assert.equal(ep(id, 1).state, 'watched', 'a real new playback counts');
});

test('deleting from Plex, or Plex unwatching, keeps history and clears only availability', async () => {
  const id = showOf(20);
  fake.episodes = fake.episodes.filter((e) => e.ratingKey !== 'e20');
  await plex.syncPlex();
  assert.equal(ep(id, 1).in_plex, 0);
  assert.equal(ep(id, 1).state, 'watched');
});

test('an empty Plex library changes nothing, and Plex being down fails cleanly', async () => {
  const saved = fake.episodes;
  const events0 = count('SELECT COUNT(*) FROM watch_events');
  const inPlex = count('SELECT COUNT(*) FROM episodes WHERE in_plex = 1');
  fake.episodes = [];
  await assert.rejects(plex.syncPlex(), /changing nothing/);
  fake.episodes = saved;
  fake.down = true;
  await assert.rejects(plex.syncPlex());
  fake.down = false;
  assert.equal(count('SELECT COUNT(*) FROM episodes WHERE in_plex = 1'), inPlex);
  assert.equal(count('SELECT COUNT(*) FROM watch_events'), events0);
});

test('webhook: only your scrobbles count, it records the same key as reconciliation, archived stays', async () => {
  const id = showOf(10);
  const viewed = nowS - 3600;
  fake.episodes.push(plexEp('e4b', 's1', 1, 2, viewed));
  const hook = { event: 'media.scrobble', Account: { id: 1 }, Metadata: { type: 'episode', ratingKey: 'e4b' } };

  assert.equal(await plex.handleWebhook({ ...hook, Account: { id: 639945452 } }), 'ignored', 'another account');
  assert.equal(await plex.handleWebhook({ ...hook, event: 'media.play' }), 'ignored', 'started is not watched');
  assert.equal(await plex.handleWebhook({ ...hook, Metadata: { type: 'movie', ratingKey: 'e4b' } }), 'ignored', 'not an episode');
  assert.equal(ep(id, 2).state, null);

  db.prepare(`UPDATE shows SET tracking_state = 'archived' WHERE id = ?`).run(id);
  assert.equal(await plex.handleWebhook(hook), 'added');
  assert.equal(ep(id, 2).state, 'watched');
  assert.equal(ep(id, 2).in_plex, 1);
  assert.equal(await plex.handleWebhook(hook), 'known', 'a repeat is harmless');
  const before = count('SELECT COUNT(*) FROM watch_events');
  await plex.syncPlex();
  assert.equal(count('SELECT COUNT(*) FROM watch_events'), before, 'reconciliation sees the same watch');
  assert.equal(db.prepare('SELECT tracking_state FROM shows WHERE id = ?').pluck().get(id), 'archived');

  // A scrobble for something Plex doesn't report as watched is left to reconciliation.
  fake.episodes.push(plexEp('e4c', 's1', 1, 3));
  assert.equal(await plex.handleWebhook({ ...hook, Metadata: { type: 'episode', ratingKey: 'e4c' } }), 'not_watched');
});

test('webhook payload parsing handles a thumbnail part and rejects junk', () => {
  const b = 'XX';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n{"event":"media.scrobble","Metadata":{"title":"Café"}}\r\n--${b}\r\nContent-Disposition: form-data; name="thumb"; filename="t.jpg"\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0x00]),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const parsed = plex.parseWebhook(body, `multipart/form-data; boundary=${b}`) as { event: string; Metadata: { title: string } };
  assert.equal(parsed.event, 'media.scrobble');
  assert.equal(parsed.Metadata.title, 'Café');
  assert.equal(plex.parseWebhook(Buffer.from('nope'), `multipart/form-data; boundary=${b}`), null);
  assert.equal(plex.parseWebhook(body, 'application/json'), null);
});

test('a held Plex show records nothing, even with valid episode IDs, until assigned in bulk', async () => {
  // Real episode ID and real show ID, but Plex lists another show's files under this show.
  tvShow(40, 4040);
  tvEps(40, 3);
  await tvmaze.addShow(40);
  const target = showOf(40);
  db.prepare(`INSERT INTO episode_ids (episode_id, provider, external_id) VALUES (?, 'tvdb', '777')`).run(ep(target, 1).id);
  db.prepare(`INSERT INTO plex_holds (plex_guid, title, reason, created_at) VALUES ('plex://show/held', 'ZZTEST held', 'wrong match', '2026-01-01')`).run();
  const showsBefore = count('SELECT COUNT(*) FROM shows');
  const t1 = nowS - 20 * day;
  const heldEp = (key: string, n: number, t: number, extra = {}) => plexEp(key, 'h1', 1, n, t, { grandparentGuid: 'plex://show/held', ...extra });
  fake.shows.push({ ...plexShow('h1', 8888), guid: 'plex://show/held' });
  fake.episodes.push(heldEp('h-e1', 1, t1, { Guid: [{ id: 'tvdb://777' }] }), heldEp('h-e2', 2, t1 + day), heldEp('h-e9', 9, t1 + 2 * day));
  await plex.syncPlex();
  assert.equal(count('SELECT COUNT(*) FROM shows'), showsBefore, 'no show created from a held one');
  assert.equal(ep(target, 1).state, null, 'a valid episode ID is not trusted while held');
  assert.equal(ep(target, 1).in_plex, 0);
  const rows = db.prepare(`SELECT id, reason FROM unmatched_watches WHERE source_key LIKE 'plex://episode/h-%' ORDER BY id`).all() as { id: number; reason: string }[];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.reason === 'On hold: wrong match'));

  const webhook = await plex.handleWebhook({ event: 'media.scrobble', Account: { id: 1 }, Metadata: { type: 'episode', ratingKey: 'h-e1' } });
  assert.equal(webhook, 'unmatched', 'the webhook respects the hold too');

  const result = plex.bulkAssign(rows.map((r) => r.id), target);
  assert.deepEqual(result, { assigned: 2, skipped: 1 }, 'no S1E9 there, so that one stays open');
  assert.equal(ep(target, 1).state, 'watched');
  assert.equal(ep(target, 2).occurred_at_utc, new Date((t1 + day) * 1000).toISOString());
  assert.equal(count(`SELECT COUNT(*) FROM unmatched_watches WHERE id = ? AND status = 'open'`, rows[2].id), 1);

  const events0 = count('SELECT COUNT(*) FROM watch_events');
  await plex.syncPlex();
  assert.equal(count('SELECT COUNT(*) FROM watch_events'), events0, 'a resync adds nothing after assignment');
  assert.equal(ep(target, 1).in_plex, 1, 'assigned episodes show as available');
  assert.equal(ep(target, 3).in_plex, 0);
});

test('bonus files are set aside; file and episode titles settle date and numbering disagreements', async () => {
  tvShow(50, 5050);
  fake.tvEpisodes[50] = [
    { id: 5001, name: 'Mysteries of the Great Pyramid', season: 1, number: 1, type: 'regular', airdate: date(-30), airstamp: `${date(-30)}T01:00:00+00:00` },
    { id: 5002, name: 'Legacy', season: 1, number: 2, type: 'regular', airdate: date(-29), airstamp: `${date(-29)}T01:00:00+00:00` },
    { id: 5003, name: 'Twilight of the Apprentice', season: 1, number: 3, type: 'regular', airdate: date(-28), airstamp: `${date(-28)}T01:00:00+00:00` },
    { id: 5004, name: 'Heroes: Part 1', season: 1, number: 4, type: 'regular', airdate: date(-27), airstamp: `${date(-27)}T01:00:00+00:00` },
    { id: 5005, name: 'Heroes: Part 2', season: 1, number: 5, type: 'regular', airdate: date(-27), airstamp: `${date(-27)}T01:00:00+00:00` },
  ];
  await tvmaze.addShow(50);
  const id = showOf(50);
  const file = (f: string) => ({ Media: [{ Part: [{ file: f }] }] });
  const old = { originallyAvailableAt: date(-400) };
  fake.shows.push(plexShow('s5', 5050));
  fake.episodes.push(
    // Plex's own title is wrong and its date disagrees; the file says what was played.
    plexEp('x1', 's5', 1, 1, nowS - 3 * day, { ...old, title: 'Something Else', ...file('D:\\TV\\Show\\Show.S01E01.Mysteries.of.the.Great.Pyramid.1080p.WEB.mkv') }),
    // Numbered differently; only the title places it.
    plexEp('x2', 's5', 1, 9, nowS - 3 * day, { title: 'Episode 9', ...file('D:\\TV\\Show\\Show.S01E09.Legacy.720p.HDTV.mkv') }),
    // A two-parter TVmaze lists once.
    plexEp('x3', 's5', 1, 8, nowS - 3 * day, { title: 'Episode 8', ...file('D:\\TV\\Show\\Show.S01E08.Twilight.of.the.Apprentice.Part.2.1080p.mkv') }),
    // Two TVmaze episodes fit "Heroes": not a match.
    plexEp('x4', 's5', 1, 7, nowS - 3 * day, { title: 'Heroes', ...file('D:\\TV\\Show\\Show.S01E07.1080p.mkv') }),
    // Bonus material.
    plexEp('x5', 's5', 1, 0, nowS - 3 * day, { title: 'Episode 0', ...file('D:\\TV\\Show\\Show.S01E00.Comic.Con.Panel.1080p.mkv') }),
    plexEp('x6', 's5', 0, 6, nowS - 3 * day, { title: 'Legacy', ...file('D:\\TV\\Show\\Show.S01.Extras\\06 Inside Legacy.mkv') }),
  );
  await plex.syncPlex();
  const e = (n: number) => ep(id, n).state;
  assert.equal(e(1), 'watched', 'file title beats a wrong Plex title and date');
  assert.equal(e(2), 'watched');
  assert.equal(e(3), 'watched', '"Part 2" places on the single combined episode');
  assert.equal(e(4), null);
  assert.equal(e(5), null);
  const reason = (k: string) => db.prepare(`SELECT reason || ':' || status FROM unmatched_watches WHERE source_key LIKE ?`).pluck().get(`plex://episode/${k}:%`) as string | undefined;
  assert.match(reason('x4') ?? '', /No S1E7.*:open/);
  assert.equal(reason('x5'), undefined, 'bonus files are never queued');
  assert.equal(reason('x6'), undefined);
  assert.equal(plex.fileTitle('C:\\a\\The.Blacklist.S04E08.1080p.WEB-DL.mkv'), null);
  assert.equal(plex.fileTitle('C:\\a\\Star Wars The Clone Wars s03e21 (720p).mkv'), null);
  assert.equal(plex.fileTitle('D:\\a\\Interview.with.the.Vampire.S03E04.The.Devils.Road.1080p.AMZN.WEB-DL.mkv'), 'The Devils Road');
});

test('a play within 6 hours of another counts once but both records are kept', () => {
  const id = showOf(20);
  const e = ep(id, 2).id;
  const t = Date.now() - 200 * 86400000;
  events.addExternalWatch({ episodeId: e, source: 'plex', key: 'zz-a', occurredAt: new Date(t).toISOString(), raw: {} });
  events.addExternalWatch({ episodeId: e, source: 'trakt', key: 'zz-b', occurredAt: new Date(t + 3600000).toISOString(), raw: {} });
  const rows = db.prepare(`SELECT source_event_key k, duplicate_of d FROM watch_events WHERE source_event_key IN ('zz-a', 'zz-b') ORDER BY id`).all() as { k: string; d: number | null }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].d, null);
  assert.notEqual(rows[1].d, null);
});
