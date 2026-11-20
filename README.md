# Seenarr

**A self-hosted, permanent TV watch history. A Trakt replacement that you own.** By H0m3Lab.

Seenarr keeps one person's complete record of every episode they've watched, fed automatically
from Plex and organised by your Sonarr library, with episode data from TVmaze. Your history lives
in a single SQLite file on your own server, and nothing gets lost when Plex or Sonarr is rebuilt.

## Features

- **Dashboard:** Continue Watching ("next: S03E05"), new episodes, Coming Soon.
- **My Shows / Show pages:** season-by-season progress. Mark episodes, seasons or whole shows watched or unwatched.
- **Recently Watched:** with a source badge (Plex, Trakt, Prime Video, Netflix, by hand) and filters.
- **Plex:** an hourly history sync plus an optional webhook for instant updates. Only your account's plays
  count (`PLEX_ACCOUNT_ID`), so family members' viewing doesn't land in your history.
- **Sonarr:** your series list becomes your show list. New series arrive as "discovered", off the
  dashboard, until you watch them.
- **Imports:** Trakt data export (matched by TVDB/IMDb/TMDB ids), Prime Video history. Every import has a
  preview first and makes a database copy before it writes anything.
- **Review queue:** plays it can't place with confidence are parked for you, never guessed. Bonus files and
  extras are filtered out.
- **History you can trust:** watch events are append-only and the "watched" state is derived from them, so a
  resync can't undo your manual changes. Episodes are never deleted, only flagged. Deleting a show is
  GUI-only, and it is remembered so syncs don't bring it back.

## Install (Docker)

```bash
git clone https://github.com/H0m3Lab/seenarr.git && cd seenarr
cp docker-compose.example.yml docker-compose.yml   # adjust the data path, Plex/Sonarr URLs, port
cp .env.example .env && chmod 600 .env
docker compose build

# login password: prints a base64 argon2 hash, paste it into .env as PASSWORD_HASH_B64
printf '%s' 'your-password' | docker run --rm -i --network none seenarr:local node server/dist/cli.js hash-password

docker compose up -d
```

Open `http://<host>:8210` and log in. Then add your Sonarr and Plex details (see below), or start by adding
shows by hand. Seenarr is single-user and meant for your LAN. If you put it behind a reverse proxy with
HTTPS, set `COOKIE_SECURE=true`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PASSWORD_HASH_B64` | | login password hash (see above; base64 so Compose can't mangle the `$` signs) |
| `SONARR_URL`, `SONARR_API_KEY` | | your Sonarr (Settings → General → API Key). Read-only use |
| `PLEX_URL`, `PLEX_TOKEN` | | your Plex server and a Plex token. Read-only use |
| `PLEX_ACCOUNT_ID` | `1` | whose plays count: `1` is the Plex server owner |
| `PLEX_WEBHOOK_SECRET` | | optional. Add the webhook URL shown on the Settings page in Plex (needs Plex Pass) |
| `COOKIE_SECURE` | `false` | `true` when served over HTTPS |
| `DATA_DIR` | `/data` | where the SQLite database lives (back it up) |
| `TVMAZE_GAP_MS` | `700` | pause between TVmaze requests |
| `DISABLE_SCHEDULER` | `false` | `true` turns off the background syncs (for test copies) |

## Backups

Everything is in `DATA_DIR/tv-tracker.db` (SQLite, WAL mode). Back up the whole `DATA_DIR` folder,
or use `sqlite3 tv-tracker.db ".backup copy.db"` for a consistent copy while it runs.

## Development

Fastify + TypeScript server, React + Vite + TanStack Query front end, better-sqlite3. Tests run against the built
image: `docker run --rm seenarr:local node --test 'server/dist/test/*.test.js'`.
The internal name is still `tv-tracker` (package names, database file, container); only the display name
is Seenarr.

## License

MIT - see [LICENSE](LICENSE). Show data from [TVmaze](https://www.tvmaze.com/api) (CC BY-SA).
Not affiliated with Plex, Sonarr, Trakt or TVmaze.
