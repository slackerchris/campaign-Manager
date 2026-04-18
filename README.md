# DND Dashboard

A campaign management web app for an ongoing D&D game.

The project combines a React frontend with an Express API. It handles campaign state, player-facing and DM-facing workflows, transcript ingestion, approval-driven canon updates, and a SQLite-first persistence model.

## What It Does

- Create and manage campaigns stored under `data/campaigns/`
- Track player characters, sessions, approvals, quotes, journals, DM notes, lexicon terms, places, bard tales, and DM sneak-peek items
- Import reference data from PDFs and `dnd-data`
- Run a transcription pipeline for audio or transcript uploads
- Keep pipeline output in an approval queue until the DM approves changes
- Complete multi-tenant roles across campaign participants (DM vs Player Workspaces)
- Persist campaign state and authentication contexts entirely in SQLite.

## Architecture

- `src/` — React app
- `server.mjs` — Express API, import pipeline, persistence, and migration helpers
- `data/campaigns/<campaign-id>/` — per-campaign `campaign.sqlite` plus filesystem artifact directories
- `docs/PIPELINE_CHATGPT_MODE.md` — transcription pipeline behavior and configuration

The app uses a campaign shell layout (`CampaignLayout`) with a flat top nav that automatically adjusts visibility depending on the currently authenticated User Role:

- **Dashboard** — stat cards, PC avatars, recent journal entries
- **Admin Setup & Login Gateways** — `/setup` claims a fresh installation, and `/campaigns/:id/login` centralizes the passwordless Player Invite flow alongside the DM system unlock.
- **DM** — DM-only workflows split across four tabs:
  - *Session* — session manager, transcription pipeline, module PDF import
  - *Review* — import highlights, approval queue, journal + transcript viewer
  - *Campaign* — PC list, DM notes, sneak-peek editor
  - *Tools* — data browser
- **Player Workspaces** — personal player environments containing dedicated contextual views
- **Lexicon** — searchable canon entries (NPCs, places, terms)
- **Settings** — LLM config, ASR config, API key management

A **←** link in the nav returns to the multi-campaign selector.

## Local Development

Requirements:

- Node.js 22+
- npm

Install dependencies:

```bash
npm install
```

Copy the example env file and fill in values:

```bash
cp .env.example .env
```

Run the frontend:

```bash
npm run dev
```

Run the API:

```bash
npm run api
```

Default ports:

- frontend: `5173`
- API: `8790`

The Vite dev server proxies `/api` requests to `http://127.0.0.1:8790`.

## Docker

Build and run with Docker Compose:

```bash
docker compose up --build
```

The container serves the built React app and the Express API on port `8790`.

Container notes:

- campaign data is mounted from `./data` into `/app/data`
- the image includes `python3`, `ffmpeg`, `openssh-client`, and `pdftotext` support via `poppler-utils`
- Python packages are installed into a venv at `/opt/venv` (not system-wide)
- `DIARIZATION_MODE=pyannote` still requires the relevant Python packages inside the container or a derived image that installs them

## Persistence Model

The app is SQLite-first for campaign state.

- `campaign.sqlite` is the source of truth for all metadata. It internally isolates Data Tables (`users`, `invites`, `sessions_auth`, `journal_entries`, `lexicon_entities`, `tracker_rows`) preventing cross-contamination across sessions.
- Component row visibility is natively protected via `user_id` and `visibility` restrictions enforced by back-end middleware constraints.
- `meta.json`, raw `sessions/` snapshots, and import artifacts under `imports/` still live on disk outside the SQLite database.

Common campaign files include:

- `meta.json`
- `campaign.sqlite`
- `exports/`
- `backups/`
- `sessions/`
- `imports/`

## Export And Backup

- `GET /api/campaigns/:id/export` returns a JSON export payload from live SQLite-backed state.
- `POST /api/campaigns/:id/export` writes that payload to `data/campaigns/<campaign-id>/exports/`.
- `POST /api/campaigns/:id/backup` writes a SQLite backup and manifest to `data/campaigns/<campaign-id>/backups/`.

## Security

- **Initial Setup**: A fresh instance has an empty `APP_TOKEN`. Navigate your browser to `/setup` to assign the Master Configuration password. This locks the application.
- **Dynamic Role-Gating Auth**: Player links use generated `/join/<token>` routes. `APP_TOKEN` simply serves as the emergency vault to bootstrap initial `DM` accounts via the `/campaigns/:id/login` gateway API. Bearer Session cookies are issued automatically and managed in `localStorage`.
- **CORS**: set `CORS_ORIGINS` to a comma-separated list of allowed origins. Defaults to `localhost` only when unset.
- **Body size**: JSON request bodies are capped at 10 MB and file uploads default to 200 MB (`MAX_UPLOAD_BYTES`).
- **Job concurrency**: at most `MAX_CONCURRENT_JOBS` (default 3) transcription jobs run simultaneously; further requests receive HTTP 429.

## Important Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions. Key variables:

- `API_PORT` — listening port (default `8790`)
- `DATA_DIR` — path to campaign data directory (default `./data`)
- `APP_TOKEN` — bearer token for API authentication (unset = no auth)
- `CORS_ORIGINS` — comma-separated allowed origins (unset = localhost only)
- `MAX_UPLOAD_BYTES` — max file upload size in bytes (default 200 MB)
- `JOB_RETENTION_MS` — how long completed jobs are kept in memory
- `MAX_RETAINED_JOBS` — max number of jobs to keep in memory
- `MAX_CONCURRENT_JOBS` — max simultaneous transcription jobs (default 3)
- `CAMPAIGN_DB_CACHE_MAX` — max open SQLite connections in LRU cache (default 10)

LLM and pipeline:

- `LLM_PROVIDER` — `ollama` | `openai` | `anthropic` | `gemini`
- `LLM_MODEL`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `PIPELINE_CHATGPT_ONLY` — force all pipeline calls through OpenAI
- `PIPELINE_OPENAI_MODEL`
- `PIPELINE_OPENAI_FALLBACK_MODEL`

Diarization and audio processing:

- `DIARIZATION_MODE` — `auto` | `llm` | `pyannote`
- `DIARIZATION_ASR_MODEL`
- `DIARIZATION_ASR_DEVICE`
- `DIARIZATION_COMPUTE_TYPE`
- `DIARIZATION_PYANNOTE_DEVICE`
- `PYANNOTE_HF_TOKEN`
- `ASR_PROVIDER` — `remote` | `local` | `groq` | `openai`
- `OLLAMA_SSH_KEY`
- `OLLAMA_SSH_USER`
- `OLLAMA_SSH_HOST`
- `REMOTE_AUDIO_DIR`
- `REMOTE_OUT_DIR`
- `WHISPER_MODEL`
- `WHISPER_DEVICE`
- `WHISPER_CHUNK_SECONDS`
- `GROQ_API_KEY`
- `GROQ_WHISPER_MODEL`

## Notes

- The transcription pipeline can run in flexible mode (any configured LLM) or legacy ChatGPT-locked mode (`PIPELINE_CHATGPT_ONLY=true`).
- Audio jobs snapshot the active `LLM_PROVIDER`, `LLM_MODEL`, and `ASR_PROVIDER` at creation time so live settings changes don't affect running jobs.
