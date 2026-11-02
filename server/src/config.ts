const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined ? v : fallback;
};

export const config = {
  dataDir: process.env.DATA_DIR ?? '/data',
  port: num('PORT', 3000),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  passwordHash: process.env.PASSWORD_HASH_B64
    ? Buffer.from(process.env.PASSWORD_HASH_B64, 'base64').toString('utf8')
    : '',
  sonarrUrl: (process.env.SONARR_URL ?? '').replace(/\/$/, ''),
  sonarrKey: process.env.SONARR_API_KEY ?? '',
  plexUrl: (process.env.PLEX_URL ?? '').replace(/\/$/, ''),
  plexToken: process.env.PLEX_TOKEN ?? '',
  plexAccountId: num('PLEX_ACCOUNT_ID', 1), // the server owner's account on this Plex server
  plexWebhookSecret: process.env.PLEX_WEBHOOK_SECRET ?? '',
  tvmazeUrl: (process.env.TVMAZE_URL ?? 'https://api.tvmaze.com').replace(/\/$/, ''),
  tvmazeGapMs: num('TVMAZE_GAP_MS', 700), // ~1.4 req/s: well under their limit, gentle on the router
  httpRetries: num('HTTP_RETRIES', 3),
  httpBackoffMs: num('HTTP_BACKOFF_MS', 2000),
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',
};
