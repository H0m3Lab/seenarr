import { config } from '../config.js';
import { db, getSetting, nowIso } from '../db.js';
import { syncSonarr } from './sonarr.js';
import { syncMetadata } from './tvmaze.js';

type Source = 'sonarr' | 'metadata';
const runners: Record<Source, () => Promise<unknown>> = { sonarr: syncSonarr, metadata: syncMetadata };

// Jobs run one at a time, in order, so a Sonarr import and a metadata pass never interleave.
let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<Source>();

export function isBusy(source: Source) {
  return queued.has(source);
}

export function runJob(source: Source): Promise<void> {
  if (queued.has(source)) return Promise.resolve();
  queued.add(source);
  const run = chain.then(async () => {
    const id = db.prepare(`INSERT INTO sync_runs (source, started_at, status) VALUES (?, ?, 'running')`).run(source, nowIso()).lastInsertRowid;
    try {
      const summary = await runners[source]();
      db.prepare(`UPDATE sync_runs SET status = 'ok', finished_at = ?, summary = ? WHERE id = ?`).run(nowIso(), JSON.stringify(summary), id);
      // New series shouldn't wait for the next metadata pass.
      if (source === 'sonarr' && (summary as { added?: number }).added) setTimeout(() => void runJob('metadata'), 0);
    } catch (err) {
      db.prepare(`UPDATE sync_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?`).run(nowIso(), (err as Error).message, id);
    } finally {
      queued.delete(source);
      db.prepare(`DELETE FROM sync_runs WHERE source = ? AND id NOT IN (SELECT id FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 500)`).run(source, source);
    }
  });
  chain = run;
  return run;
}

export const DEFAULT_MINUTES: Record<Source, number> = { sonarr: 60, metadata: 360 };
export const minutesFor = (s: Source) => Number(getSetting(`sync_minutes_${s}`, String(DEFAULT_MINUTES[s]))) || DEFAULT_MINUTES[s];

const RETRY_AFTER_ERROR_MINUTES = 15;

const lastRun = (s: Source) =>
  db.prepare('SELECT started_at, status FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 1').get(s) as { started_at: string; status: string } | undefined;

/** Checks once a minute rather than holding timers, so a changed frequency applies straight away. */
export function startScheduler() {
  // A run cut off by a restart would otherwise look like it's still going.
  db.prepare(`UPDATE sync_runs SET status = 'error', finished_at = ?, error = 'Interrupted by restart' WHERE status = 'running'`).run(nowIso());
  if (config.disableScheduler) return;
  const tick = () => {
    for (const s of ['sonarr', 'metadata'] as Source[]) {
      if (s === 'sonarr' && (!config.sonarrUrl || !config.sonarrKey)) continue;
      const last = lastRun(s);
      // A failed run retries sooner than the normal interval, so an outage clears by itself.
      const wait = last?.status === 'error' ? Math.min(minutesFor(s), RETRY_AFTER_ERROR_MINUTES) : minutesFor(s);
      if (!last || Date.now() - Date.parse(last.started_at) >= wait * 60000) void runJob(s);
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60000);
}
