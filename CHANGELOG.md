# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-19

First public release.

### Added
- Dashboard with Continue Watching, new episodes, and Coming Soon.
- My Shows and Show pages with season progress; mark episodes, seasons, or whole shows watched
  or unwatched, with a "hide fully watched" toggle.
- Sonarr sync (series list) and TVmaze episode data, with retries after failed syncs.
- Plex history sync (hourly) and optional webhook; only `PLEX_ACCOUNT_ID`'s plays count.
- Review queue for plays that cannot be placed with confidence; Plex bonus files set aside.
- Matching by file and episode title when dates or numbering disagree, ignoring apostrophes.
- Trakt data export import (ID matching, bulk-click dates kept unknown, missing shows added by ID).
- Prime Video history import with preview, show linking, and a database copy before writing.
- Recently Watched page with source badges and source filter; archived shows hidden.
- Show deletion from the web app only, remembered so syncs do not re-create it.
- Docker image, example Compose file, `.env.example`, MIT license.
- Project docs (CLAUDE.md, this changelog), CI (build, tests, Docker build, secret scan), `npm test`.

[Unreleased]: https://github.com/H0m3Lab/seenarr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/H0m3Lab/seenarr/releases/tag/v0.1.0
