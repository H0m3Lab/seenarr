import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { db, getSetting, nowIso, setSetting } from './db.js';
import { deleteShow } from './services/delete.js';
import { correctWatchDate, setWatched, type WatchDate } from './services/events.js';
import { addShowIds, closeReview, getShowIds } from './services/identity.js';
import { isBusy, minutesFor, runJob } from './services/jobs.js';
import { linkSonarr } from './services/link.js';
import { assignUnmatched, bulkAssign, handleWebhook, parseWebhook, testPlex } from './services/plex.js';
import { allSummaries, dashboard, episodesForShow, isAired, markShowsWatched, summarise, type ShowRow } from './services/progress.js';
import { testSonarr } from './services/sonarr.js';
import { addShow, refreshShow, searchShows, testTvmaze } from './services/tvmaze.js';

export const WEBHOOK_PREFIX = '/api/v1/webhooks/';
const SOURCES = ['sonarr', 'metadata', 'plex'] as const;
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
    if (!url.startsWith('/api/') || PUBLIC.has(url) || url.startsWith(WEBHOOK_PREFIX)) return;
    if (!validSession(req)) throw fail(401, 'Not signed in');
    // A custom header can't be sent cross-site without CORS, which we don't enable.
    if (req.method !== 'GET' && req.headers['x-tv-tracker'] !== '1') throw fail(403, 'Missing request header');
  });

  // Plex can't sign in, so the unguessable URL is the credential. It is kept out of the logs.
  app.post('/api/v1/webhooks/plex/:secret', { bodyLimit: 20 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const given = Buffer.from((req.params as { secret: string }).secret);
    const expected = Buffer.from(config.plexWebhookSecret);
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail(404, 'Not found');
    const hook = parseWebhook(req.body as Buffer, String(req.headers['content-type'] ?? ''));
    if (!hook) throw fail(400, 'Unreadable payload');
    setSetting('plex_webhook_last_seen', nowIso());
    // Answer straight away; a failure here is caught by the next reconciliation.
    void handleWebhook(hook)
      .then((result) => {
        if (result === 'ignored') return;
        db.prepare(`INSERT INTO sync_runs (source, started_at, finished_at, status, summary) VALUES ('plex-webhook', ?, ?, 'ok', ?)`).run(nowIso(), nowIso(), JSON.stringify({ result }));
      })
      .catch((err: Error) => {
        db.prepare(`INSERT INTO sync_runs (source, started_at, finished_at, status, error) VALUES ('plex-webhook', ?, ?, 'error', ?)`).run(nowIso(), nowIso(), err.message);
      });
    return reply.code(200).send({ ok: true });
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

  // The only way a show is ever deleted: your click in the web app, confirmed. No sync or job calls this.
  app.delete('/api/v1/shows/:id', async (req) => {
    const id = z.coerce.number().int().parse((req.params as { id: string }).id);
    z.object({ confirm: z.literal(true) }).parse(req.body);
    const result = deleteShow(id);
    if (!result) throw fail(404, 'No such show');
    return result;
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

  // Whole shows (one or many): every aired regular episode, never specials or unaired ones.
  // Already-watched episodes are skipped, so their real dates stay as they are.
  app.post('/api/v1/shows/watched', async (req) => {
    const b = z.object({ ids: z.array(z.number().int()).min(1).max(5000), date: dateInput.optional() }).parse(req.body);
    return { changed: markShowsWatched(b.ids, (b.date ?? { mode: 'unknown' }) as WatchDate) };
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
      (SELECT COUNT(*) FROM review_queue WHERE status = 'open') AS reviewOpen,
      (SELECT COUNT(*) FROM unmatched_watches WHERE status = 'open') AS unmatchedOpen`).get();
    return {
      // Only whether keys exist, never the keys.
      sonarr: { configured: !!(config.sonarrUrl && config.sonarrKey), url: config.sonarrUrl, busy: isBusy('sonarr'), minutes: minutesFor('sonarr'), last: last('sonarr') },
      metadata: { provider: 'TVmaze', busy: isBusy('metadata'), minutes: minutesFor('metadata'), last: last('metadata') },
      plex: {
        configured: !!(config.plexUrl && config.plexToken),
        url: config.plexUrl,
        busy: isBusy('plex'),
        minutes: minutesFor('plex'),
        last: last('plex'),
        webhookConfigured: !!config.plexWebhookSecret,
        webhookLastSeen: getSetting('plex_webhook_last_seen', '') || null,
      },
      counts,
    };
  });

  app.put('/api/v1/settings/frequency', async (req) => {
    const b = z.object({ source: z.enum(SOURCES), minutes: z.number().int().min(5).max(10080) }).parse(req.body);
    setSetting(`sync_minutes_${b.source}`, String(b.minutes));
    return { ok: true };
  });

  app.post('/api/v1/sync/:source', async (req) => {
    const { source } = z.object({ source: z.enum(SOURCES) }).parse(req.params);
    void runJob(source);
    return { started: true };
  });

  app.post('/api/v1/test/:source', async (req) => {
    const { source } = z.object({ source: z.enum(SOURCES) }).parse(req.params);
    try {
      return { ok: true, message: await (source === 'sonarr' ? testSonarr() : source === 'plex' ? testPlex() : testTvmaze()) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  app.get('/api/v1/sync-log', async () =>
    db.prepare('SELECT id, source, started_at, finished_at, status, summary, error FROM sync_runs ORDER BY id DESC LIMIT 100').all());

  app.get('/api/v1/review', async () =>
    db.prepare(`SELECT r.id, r.type, r.show_id, r.summary, r.payload, r.created_at, r.updated_at, s.title AS show_title
      FROM review_queue r LEFT JOIN shows s ON s.id = r.show_id WHERE r.status = 'open' ORDER BY s.sort_title, r.id LIMIT 500`).all());

  app.post('/api/v1/review/:id/resolve', async (req) => {
    const id = z.coerce.number().int().parse((req.params as { id: string }).id);
    const b = z.object({
      action: z.enum(['trust_numbering', 'same_show', 'not_this_show', 'keep_sonarr', 'link_tvmaze']),
      tvmazeId: z.number().int().positive().optional(),
    }).parse(req.body);
    const item = db.prepare('SELECT id, dedupe_key, type, show_id FROM review_queue WHERE id = ?').get(id) as { id: number; dedupe_key: string; type: string; show_id: number | null } | undefined;
    if (!item || item.show_id === null) throw fail(404, 'No such review item');
    const showId = item.show_id;
    const setPolicy = (policy: string) => db.prepare('UPDATE shows SET metadata_policy = ?, updated_at = ? WHERE id = ?').run(policy, nowIso(), showId);
    const markResolved = () => db.prepare(`UPDATE review_queue SET status = 'resolved', updated_at = ? WHERE id = ?`).run(nowIso(), id);

    if (b.action === 'trust_numbering') {
      db.prepare('UPDATE shows SET trust_numbering = 1, updated_at = ? WHERE id = ?').run(nowIso(), showId);
      linkSonarr(showId); // closes the item by itself if every episode now lines up
      void runJob('plex'); // pick up any watches this unblocks
      return { ok: true };
    }
    if (b.action === 'same_show') setPolicy('ignore_id_conflicts');
    if (b.action === 'not_this_show' || b.action === 'keep_sonarr') setPolicy('sonarr_only');
    if (b.action === 'link_tvmaze') {
      if (!b.tvmazeId) throw fail(400, 'Choose a TVmaze show');
      setPolicy('ignore_id_conflicts');
      const problems = addShowIds(showId, { tvmaze: b.tvmazeId }, true);
      if (problems.length) throw fail(409, problems[0]);
    }
    markResolved();
    closeReview(item.dedupe_key);
    await refreshShow(showId).catch(() => undefined); // retried by the next metadata pass
    void runJob('plex');
    return { ok: true };
  });

  app.get('/api/v1/unmatched', async () =>
    db.prepare(`SELECT u.id, u.source, u.show_id, u.reason, u.occurred_at_utc, u.payload, s.title AS show_title
      FROM unmatched_watches u LEFT JOIN shows s ON s.id = u.show_id WHERE u.status = 'open'
      ORDER BY s.sort_title, u.occurred_at_utc LIMIT 1000`).all());

  app.post('/api/v1/unmatched/bulk-assign', async (req) => {
    const b = z.object({ ids: z.array(z.number().int()).min(1).max(1000), showId: z.number().int() }).parse(req.body);
    return bulkAssign(b.ids, b.showId);
  });

  app.post('/api/v1/unmatched/:id', async (req) => {
    const id = z.coerce.number().int().parse((req.params as { id: string }).id);
    const b = z.union([z.object({ episodeId: z.number().int() }), z.object({ dismiss: z.literal(true) })]).parse(req.body);
    if ('dismiss' in b) {
      db.prepare(`UPDATE unmatched_watches SET status = 'dismissed', updated_at = ? WHERE id = ?`).run(nowIso(), id);
      return { ok: true };
    }
    if (!assignUnmatched(id, b.episodeId)) throw fail(404, 'No such watch or episode');
    return { ok: true };
  });
}
