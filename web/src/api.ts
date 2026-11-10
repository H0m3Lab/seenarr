export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'X-TV-Tracker': '1',
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Request failed');
  return data as T;
}

export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export interface EpisodeBrief {
  id: number;
  season: number;
  number: number | null;
  title: string | null;
  air_at_utc: string | null;
  air_date: string | null;
  available: boolean;
}

export interface Progress {
  aired: number;
  watched: number;
  remaining: number;
  percent: number;
  lastWatched: (EpisodeBrief & { watchedAt: string | null; source: string | null }) | null;
  nextToWatch: EpisodeBrief | null;
  nextAfterLast: EpisodeBrief | null;
  nextToAir: EpisodeBrief | null;
  availableUnwatched: number;
}

export type Tracking = 'discovered' | 'following' | 'archived';

export interface ShowSummary {
  id: number;
  title: string;
  status: string;
  overview: string | null;
  network: string | null;
  premiere_date: string | null;
  poster_file: string | null;
  tracking_state: Tracking;
  metadata_state: string;
  in_sonarr: number;
  sonarr_removed_at: string | null;
  inPlex: boolean;
  hasFiles: boolean;
  seasons: number;
  progress: Progress;
}

export interface Episode {
  id: number;
  season: number;
  number: number | null;
  kind: 'regular' | 'special';
  title: string | null;
  overview: string | null;
  air_at_utc: string | null;
  air_date: string | null;
  orphaned: number;
  has_file: number;
  in_plex: number;
  state: 'watched' | 'unwatched' | null;
  occurred_at_utc: string | null;
  source: string | null;
  aired: boolean;
}

export type ShowDetail = ShowSummary & { episodes: Episode[]; externalIds: Record<string, string> };

export interface Dashboard {
  continueWatching: ShowSummary[];
  newEpisodes: ShowSummary[];
  comingSoon: ShowSummary[];
  caughtUp: ShowSummary[];
  notStarted: ShowSummary[];
  ended: ShowSummary[];
}

export const epCode = (e: { season: number; number: number | null }) =>
  e.number === null ? `S${String(e.season).padStart(2, '0')} special` : `S${String(e.season).padStart(2, '0')}E${String(e.number).padStart(2, '0')}`;

/** Stored as UTC, shown in the browser's local time. */
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

export const fmtAir = (e: { air_at_utc: string | null; air_date: string | null }) =>
  e.air_at_utc
    ? fmtDate(e.air_at_utc)
    : e.air_date
      ? new Date(`${e.air_date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : 'TBA';
