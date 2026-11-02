import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { db, nowIso, setSetting } from './db.js';
import { correctWatchDate, setWatched, type WatchDate } from './services/events.js';
import { getShowIds } from './services/identity.js';
import { isBusy, minutesFor, runJob } from './services/jobs.js';
import { allSummaries, dashboard, episodesForShow, isAired, summarise, type ShowRow } from './services/progress.js';
import { testSonarr } from './services/sonarr.js';
import { addShow, refreshShow, searchShows, testTvmaze } from './services/tvmaze.js';

const COOKIE = 'tv_session';
const SESSION_DAYS = 30;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function validSession(req: FastifyRequest): boolean {
  const token = req.cookies[COOKIE];
  if (!token) return false;
  const expires = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').pluck().get(sha(token)) as string | undefined;
  return !!expires && expires > nowIso();
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });

const pastDate = z.string().datetime().refine((v) => Date.parse(v) <= Date.now() + 86400000, 'Date is in the future');
const dateInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('now') }),
  z.object({ mode: z.literal('unknown') }),
  z.object({ mode: z.literal('date'), at: pastDate }),
]);

export function registerRoutes(app: FastifyInstance) {
  const PUBLIC = new Set(['/api/v1/health', '/api/v1/login']);

  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || PUBLIC.has(url)) return;
    if (!validSession(req)) throw fail(401, 'Not signed in');
    // A custom header can't be sent cross-site without CORS, which we don't enable.
    if (req.method !== 'GET' && req.headers['x-tv-tracker'] !== '1') throw fail(403, 'Missing request header');
  });

  app.get('/api/v1/health', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  app.post('/api/v1/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const { password } = z.object({ password: z.string().min(1).max(1000) }).parse(req.body);
    if (!config.passwordHash) throw fail(503, 'No password has been set');
    if (!(await verify(config.passwordHash, password))) throw fail(401, 'Wrong password');
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
    db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha(token), nowIso(), expires.toISOString());
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires });
    return { ok: true };
  });

  app.post('/api/v1/logout', async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(req.cookies[COOKIE] ?? ''));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/me', async () => ({ ok: true }));
  app.get('/api/v1/dashboard', async () => dashboard());
  app.get('/api/v1/shows', async () => allSummaries());

  app.get('/api/v1/shows/:id', async (req) => {
    const id = z.coerce.number().int().parse((req.params as { id: string }).id);
    const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id) as ShowRow | undefined;
    if (!show) throw fail(404, 'No such show');
    const eps = episodesForShow(id);
    const now = new Date();
    return {
      ...summarise(show, eps, now),
      externalIds: getShowIds(id),
      episodes: eps.map((e) => ({ ...e, aired: isAired(e, now) })),
    };
  });

  app.post('/api/v1/shows/tracking', async (req) => {
    const b = z.object({ ids: z.array(z.number().int()).min(1).max(5000), state: z.enum(['discovered', 'following', 'archived']) }).parse(req.body);
    const update = db.prepare('UPDATE shows SET tracking_state = ?, updated_at = ? WHERE id = ?');
    db.transaction(() => {
      for (const id of b.ids) update.run(b.state, nowIso(), id);
    })();
    return { ok: true };
  });

  app.get('/api/v1/search', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(200) }).parse(req.query);
    try {
      return await searchShows(q);
    } catch {
      throw fail(502, "Can't reach TVmaze right now");
    }
  });

  app.post('/api/v1/shows', async (req) => {
    const { tvmazeId } = z.object({ tvmazeId: z.number().int().positive() }).parse(req.body);
    try {
      return await addShow(tvmazeId);
    } catch (err) {
      throw fail(502, (err as Error).message);
    }
  });

  app.post('/api/v1/shows/:id/refresh', async (req) => {
    const id = z.coerce.number().int().parse((req.params as { id: string }).id);
    try {
      return { result: await refreshShow(id) };
    } catch (err) {
      throw fail(502, (err as Error).message);
    }
  });

  app.post('/api/v1/episodes/:id/watched', async (req) => {
    const id = z.coerce.number().int().parse((req.params as { id: string }).id);
    const b = z.object({ watched: z.boolean(), date: dateInput.optional() }).parse(req.body);
    return { changed: setWatched([id], b.watched, (b.date ?? { mode: 'now' }) as WatchDate) };
  });

  app.post('/api/v1/episodes/:id/watch-date', async (req) => {
    const id = z.coerce.number().int().parse((req.params as { id: string }).id);
    const { at } = z.object({ at: pastDate.nullable() }).parse(req.body);
    if (!correctWatchDate(id, at)) throw fail(409, "That episode isn't marked watched");
    return { ok: true };
  });

  // Whole season: aired regular episodes only, so nothing unaired gets marked by accident.
  app.post('/api/v1/shows/:id/seasons/:season/watched', async (req) => {
    const p = req.params as { id: string; season: string };
    const id = z.coerce.number().int().parse(p.id);
    const season = z.coerce.number().int().parse(p.season);
    const b = z.object({ watched: z.boolean(), date: dateInput.optional() }).parse(req.body);
    const now = new Date();
    const ids = episodesForShow(id)
      .filter((e) => e.season === season && e.kind === 'regular' && !e.orphaned && (!b.watched || isAired(e, now)))
      .map((e) => e.id);
    return { changed: setWatched(ids, b.watched, (b.date ?? { mode: 'unknown' }) as WatchDate) };
  });

  app.get('/api/v1/posters/:file', async (req, reply) => {
    const { file } = z.object({ file: z.string().regex(/^\d+\.jpg$/) }).parse(req.params);
    const p = path.join(config.dataDir, 'posters', file);
    if (!existsSync(p)) throw fail(404, 'No poster');
    reply.header('Cache-Control', 'private, max-age=86400').type('image/jpeg');
    return reply.send(createReadStream(p));
  });

  app.get('/api/v1/settings/status', async () => {
    const last = (source: string) =>
      db.prepare('SELECT status, started_at, finished_at, summary, error FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 1').get(source) ?? null;
    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM shows) AS shows,
      (SELECT COUNT(*) FROM shows WHERE tracking_state = 'following') AS following,
      (SELECT COUNT(*) FROM shows WHERE tracking_state = 'discovered') AS discovered,
      (SELECT COUNT(*) FROM shows WHERE tracking_state = 'archived') AS archived,
      (SELECT COUNT(*) FROM shows WHERE metadata_state = 'pending') AS metadataPending,
      (SELECT COUNT(*) FROM episodes) AS episodes,
      (SELECT COUNT(*) FROM watch_events WHERE kind = 'watched' AND duplicate_of IS NULL) AS watchEvents,
      (SELECT COUNT(*) FROM review_queue WHERE status = 'open') AS reviewOpen`).get();
    return {
      // Only whether keys exist, never the keys.
      sonarr: { configured: !!(config.sonarrUrl && config.sonarrKey), url: config.sonarrUrl, busy: isBusy('sonarr'), minutes: minutesFor('sonarr'), last: last('sonarr') },
      metadata: { provider: 'TVmaze', busy: isBusy('metadata'), minutes: minutesFor('metadata'), last: last('metadata') },
      counts,
    };
  });

  app.put('/api/v1/settings/frequency', async (req) => {
    const b = z.object({ source: z.enum(['sonarr', 'metadata']), minutes: z.number().int().min(5).max(10080) }).parse(req.body);
    setSetting(`sync_minutes_${b.source}`, String(b.minutes));
    return { ok: true };
  });

  app.post('/api/v1/sync/:source', async (req) => {
    const { source } = z.object({ source: z.enum(['sonarr', 'metadata']) }).parse(req.params);
    void runJob(source);
    return { started: true };
  });

  app.post('/api/v1/test/:source', async (req) => {
    const { source } = z.object({ source: z.enum(['sonarr', 'metadata']) }).parse(req.params);
    try {
      return { ok: true, message: await (source === 'sonarr' ? testSonarr() : testTvmaze()) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  app.get('/api/v1/sync-log', async () =>
    db.prepare('SELECT id, source, started_at, finished_at, status, summary, error FROM sync_runs ORDER BY id DESC LIMIT 100').all());

  app.get('/api/v1/review', async () =>
    db.prepare(`SELECT r.id, r.type, r.show_id, r.summary, r.payload, r.created_at, r.updated_at, s.title AS show_title
      FROM review_queue r LEFT JOIN shows s ON s.id = r.show_id WHERE r.status = 'open' ORDER BY r.updated_at DESC LIMIT 500`).all());
}
