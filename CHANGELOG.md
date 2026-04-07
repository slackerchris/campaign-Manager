# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-04-07

### Security

- **CORS locked down** — the API now rejects requests from unlisted origins. Allowed origins are configured via the `CORS_ORIGINS` env var (comma-separated). Defaults to `localhost` variants only when unset. Previously all origins were accepted.
- **Timing-safe auth** — `APP_TOKEN` bearer comparison replaced with `crypto.timingSafeEqual` to prevent timing-based token oracle attacks.
- **Body size cap** — `express.json` now enforces a 10 MB limit, preventing memory exhaustion from oversized JSON payloads.
- **`/api/health` behind auth** — the health endpoint is now protected by the same `APP_TOKEN` middleware as all other `/api/*` routes. It previously exposed internal build and version info without authentication.

### Fixed

- **LLM config race condition** — `LLM_PROVIDER` and `LLM_MODEL` are module-level globals that can be changed at runtime via the Settings UI. Each audio/transcript/PDF job now snapshots `{ provider, model }` at creation time via `snapshotLlmConfig()` and uses that snapshot for all pipeline calls, so a mid-flight settings change can no longer corrupt a running transcription job.
- **ASR provider race condition** — `ASR_PROVIDER` is similarly snapshotted into `job.asrProvider` at job start in `processAudioJob`, so a live ASR config change doesn't alter an in-progress transcription.
- **`ensureSqlSchema` called on every read/write** — schema migration was re-running on every `sqlLoadCampaignDocument` and `sqlUpsertCampaignDocument` call. A `WeakSet` guard (`_schemaMigratedDbs`) now ensures migration runs exactly once per database connection.
- **`getCampaignState` sequential document loads** — 14 document fetches were awaited sequentially. They are now run in parallel via `Promise.all`, eliminating cascaded round-trips on every page load.
- **Unhandled `loadCampaignState` throws** — the function was called from 20+ places in `AppContext.jsx` with no error handling. A try/catch now catches both network and API errors and routes them through `setError`.
- **Journal entry cap silent drop** — `persistJournalEntriesSqlPrimary` silently discards entries beyond 300. A warning is now logged when trimming occurs.
- **Corrupt comment in `processTranscriptJob`** — a previous edit left a literal `\n` string inside a comment on one line, resulting in a garbled comment. Restored to two separate lines.
- **`originalname` sanitization inconsistency** — the audio upload route sanitized `req.file.originalname` before storing it, but the module-PDF and transcript-text routes stored the raw multer value. Both routes now apply `path.basename(...).replace(/[^a-zA-Z0-9._-]/g, '_')` consistently.
- **Hardcoded developer path in `npm run api`** — `package.json` `"api"` script had a hardcoded absolute path (`/home/chris/.openclaw/...`). Changed to `DATA_DIR=./data`.

### Added

- **Job rate limiting** — both `/api/transcribe` (audio) and `/api/transcribe-text` routes count active jobs and return HTTP 429 when `MAX_CONCURRENT_JOBS` (default 3, env-tunable) would be exceeded. The uploaded temp file is cleaned up before rejecting.
- **`MAX_CONCURRENT_JOBS` env var** — controls the concurrent job cap. Minimum 1.
- **`CAMPAIGN_DB_CACHE_MAX` env var** — the SQLite LRU connection cache size (previously hardcoded to 10) is now configurable.
- **`.env.example`** — documents all configurable environment variables with safe placeholder values and descriptions.

### Changed

- **Dockerfile Python isolation** — replaced `pip3 install --break-system-packages` with a proper Python venv at `/opt/venv`. The `PATH` is updated so `python3`/`pip3`/`whisper` resolve to the venv.
- **`.dockerignore` additions** — `scripts/`, `*.sqlite` added alongside existing exclusions to keep the build context lean and avoid sending local databases or Python scripts into the image.
- **README updated** — added Security section, `.env.example` reference, corrected Docker/Python notes, expanded environment variable descriptions, and removed outdated notes about missing auth.

### UI Changes

- **Flat top navigation** — replaced the Dashboard navlink + dropdown "Menu ▾" pattern with five explicit `NavLink` items (Dashboard, DM, Player, Lexicon, Settings) plus a "← Campaigns" link. Active tab is highlighted with an amber border/background. The old `globalMenuOpen` state is no longer needed.
- **DM page tabbed layout** — the DM page was a single long scroll of ~10 unrelated panels. It is now split into four tabs:
  - *Session* — session manager, transcription pipeline, module PDF import
  - *Review* — import highlights stats, approval queue, journal + transcript viewer. A floating badge shows the pending approval count and jumps to this tab on click.
  - *Campaign* — PC list (with D&D Beyond sync), DM notes, sneak-peek editor
  - *Tools* — data browser
- **Stat card color accents** — Dashboard stat cards now render a 4px colored top-border stripe. Each stat uses a distinct accent (`amber` / `blue` / `purple` / `emerald`) via a new `color` prop on `Stat`.
- **Approval modal tab labels** — tab identifiers were raw slugs (`full-journal`, `quest-tracker`, etc.). Replaced with human-readable labels (`Full Journal`, `Quest Tracker`, `NPC Tracker`, `Session Recap`, `Running Log`, `Changes`).
- **Journal pagination labels** — `Prev` / `Next` replaced with `← Older` / `Newer →` for clearer directionality.
- **Campaign list cards** — creation date is shown instead of the raw campaign ID.
- **Background scroll** — removed `backgroundAttachment: fixed` from `Landing` and `CampaignLayout`; replaced with `scroll` to avoid GPU compositing jank on mobile and some desktop browsers.
- **`App.css` cleared** — removed all Vite scaffold dead styles (`.hero`, `.vite`, `#next-steps`, `#center`, etc.).
- **`Panel` stable key** — list item key changed from bare index `i` to `` `${i}-${String(it).slice(0,40)}` `` to avoid unnecessary remounts on reorder.
- **PC avatar fallback** — removed dependency on the external `placehold.co` service. PC cards without an avatar now use a locally-served `/pc-placeholder.svg`.
- **README updated** — added UI Layout section describing the nav structure and DM tab IA.
