import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'tv-tracker.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');

export const nowIso = () => new Date().toISOString();

/** One UTC format everywhere, because event ordering compares these as strings. */
export function toUtc(value?: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    db.transaction(() => {
      db.exec(readFileSync(path.join(dir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, nowIso());
    })();
  }
}

export function getSetting(key: string, fallback: string): string {
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
  return v ?? fallback;
}

export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
