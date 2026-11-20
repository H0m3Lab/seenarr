# CLAUDE.md: Seenarr

Guide for AI coding agents (and humans) working on this repository. Organization rules:
https://github.com/H0m3Lab/.github/blob/main/STANDARDS.md

## Purpose

Seenarr is one person's permanent, self-hosted TV watch history: a Trakt replacement fed by Plex,
organised by the Sonarr library, with episode data from TVmaze. **The watched state is the product.**
Users rely on it to never rewatch an episode by mistake, so losing or corrupting it is the worst bug.

## Architecture

- **Server** (`server/`): Fastify 5 + TypeScript (ESM), better-sqlite3, zod for input validation,
  argon2 password login with a cookie session. `index.ts` starts the HTTP server and the scheduler
  (`services/jobs.ts`: Sonarr/TVmaze sync, hourly Plex history sync, retries).
- **Services** (`server/src/services/`): one module per integration or concern: `sonarr`, `tvmaze`,
  `plex` (history sync + webhook), `trakt` and `prime` (imports), `events` (watch events), `progress`
  (derived watched state), `identity` / `link` (matching), `delete`.
- **Data model:** watch events are append-only; "watched" is derived from them, so a resync cannot undo
  manual changes. Episodes are flagged, never deleted. Plays that cannot be placed go to a review queue.
- **Web** (`web/`): React 18 + Vite + TanStack Query + React Router; pages in `web/src/pages/`.
  Self-hosted fonts in `web/public/fonts/`. The server serves the built `web/dist`.

## Repository layout

```
server/src/index.ts       Fastify app, static files, scheduler start
server/src/routes.ts      HTTP API (/api/v1/...)
server/src/config.ts      every environment variable and its default
server/src/db.ts          SQLite open + migration runner (schema_migrations table)
server/src/cli.ts         CLI (e.g. hash-password)
server/src/services/      integrations and domain logic
server/src/test/          node:test suites (run against throwaway data dirs and fake HTTP servers)
server/migrations/        numbered SQL migrations, applied in order
web/src/                  React front end
Dockerfile                multi-stage build (node:22-alpine), runs as user node on port 3000
```

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` (needs python3, make, g++ for better-sqlite3 if no prebuilt binary) |
| Build | `npm run build` (web, then server) |
| Test | `npm test` (after build: runs `server/dist/test/*.test.js`) |
| Docker image | `docker compose build` or `docker build -t seenarr:local .` |
| Tests in the image | `docker run --rm seenarr:local node --test 'server/dist/test/*.test.js'` |
| Password hash | `printf '%s' 'pw' \| docker run --rm -i --network none seenarr:local node server/dist/cli.js hash-password` |

CI (`.github/workflows/ci.yml`) runs `npm ci`, build, tests, the Docker build, and a gitleaks history scan.

## Configuration

All environment variables are read in `server/src/config.ts` (README settings table; secrets in
`.env.example`). A new setting needs a default there, a README row, and a CHANGELOG line.
Use `DISABLE_SCHEDULER=true` and a separate `DATA_DIR` for test copies.

## Conventions

- TypeScript strict; validate every request body with zod.
- Use the Fastify logger (`request.log` / `app.log`), not `console.log`, in the server.
- Tests use the built-in `node:test`, a temporary `DATA_DIR`, and fake HTTP servers. No real
  Plex/Sonarr/TVmaze calls and no real show data in tests (use `ZZTEST`-style names).
- The internal name is still `tv-tracker` (package names, `tv-tracker.db`, container). Only the display
  name is Seenarr. Do not rename internals; it would break existing installs.

## Data safety (do not break)

- Watch events stay append-only. Never add code that deletes or rewrites watch history in bulk.
- Schema changes are a new `server/migrations/NNN_name.sql`. Never edit an applied migration.
- Imports must keep their preview step and the database copy made before writing.
- Deleting a show stays GUI-only and must stay remembered so syncs do not re-create it.
- Sonarr and Plex are used read-only.

## Security

- Single-user app for a LAN or behind a reverse proxy. Login is argon2 + cookie (`COOKIE_SECURE=true`
  behind HTTPS); login is rate limited.
- The Plex webhook is protected by `PLEX_WEBHOOK_SECRET`.
- No real IPs, host names, tokens, or personal viewing data in code, tests, or docs.

## Releases

Semantic versioning. The version is in `package.json`, `server/package.json`, and `web/package.json`;
keep them equal. Steps: CHANGELOG `[Unreleased]` → new version section, bump the three versions,
commit, tag `vX.Y.Z`, GitHub release with that section as notes.
