# Campaign Manager

A self-hosted web app for running D&D campaigns. Handles session transcripts, canon management, player workspaces, and an AI-assisted approval pipeline — all stored locally in SQLite.

---

## What It Does

- **Multi-campaign** — each DM runs separate campaigns independently
- **Session pipeline** — upload audio or a transcript, run it through Whisper + an LLM, and get structured NPC updates, quest changes, and journal entries staged for approval
- **Approval queue** — the DM reviews and approves AI-generated changes before they become canon
- **Lexicon** — searchable canon entries: NPCs, monsters, places, quests, items, factions, and terms. NPCs and monsters carry a D&D creature type (humanoid, undead, dragon, etc.)
- **Player workspaces** — each player has their own view of the campaign with visibility controls
- **Multi-user auth** — admin, DM, and player roles with server-level accounts and per-campaign sessions
- **Server diagnostics** — admin-only health checks, retained job history, and recent request/error logs

---

## Roles

| Role | Gets |
|------|------|
| **Admin** | Server console — manages users, invites DMs, configures API keys and ASR/LLM settings, handles campaign backups |
| **DM** | Campaign desk — creates campaigns, imports sessions, manages canon, invites players |
| **Player** | Player home — sees their campaigns, accepts DM invites, accesses their workspace |

The admin is the server owner, not the person running the games. Admins invite or promote DMs, configure shared infrastructure, recover accounts, and handle backups. DMs create and run campaigns.

---

## Quick Start

### Requirements

- Node.js 22+
- npm

### Install and run

```bash
git clone https://github.com/slackerchris/campaign-Manager.git
cd campaign-Manager
npm install
cp .env.example .env
# Edit .env with your API keys and settings
```

Run the API server:

```bash
npm run api
```

Run the frontend (development):

```bash
npm run dev
```

| Service | Port |
|---------|------|
| API | `8790` |
| Vite dev server | `5173` (proxies `/api` to `8790`) |

### First run

On first visit the app redirects to `/setup` where you create the admin account. After that:

1. Admin logs in at `/login` and goes to the Admin Console
2. Admin creates a DM invite link and sends it to the DM
3. DM creates their account, logs in, and creates a campaign
4. DM invites players from the Campaign tab (search by username)
5. Players sign up at `/login`, see the invite on their player home, and accept

---

## Admin Console

The Admin Console is the server-owner workspace. It is intentionally separate from the DM campaign desk.

### Users

- Search users by username or display name
- Filter by role
- Promote or demote DMs and players
- Reset a user's password
- Revoke a user's sessions
- Delete non-admin accounts

### Invites

- Create one-time DM or player account invite links
- Copy invite links for users to create their own accounts
- Revoke unused invites
- Show active or historical invites

### Campaigns

Admins do not create campaigns for DMs. They can inspect and operate on existing campaign records:

- Run SQLite storage checks
- Download a full campaign JSON export
- Write an export file on the server
- Create a SQLite backup
- Delete a campaign if needed

### Diagnostics

The Diagnostics tab is the first place to look when a pipeline run fails or something feels stuck.

It shows:

- Node process uptime, memory, and platform
- Campaign and job counts
- Current LLM, ASR, diarization, and job-limit settings
- Data directory writability
- Ollama reachability
- Whisper-local reachability
- Recent retained pipeline jobs
- Recent API request logs and captured `console.warn` / `console.error` messages

Diagnostics are process-local. Restarting the API clears the in-memory request log, but retained terminal jobs are reloaded from `data/jobs.sqlite`.

### Settings

Admin Settings control shared server infrastructure:

- LLM provider and model
- ASR provider
- Whisper-local endpoint, path, model, API key header, and API key
- OpenAI, Anthropic, Gemini, Groq, and Pyannote keys
- Pipeline health check

DM Settings may expose some of the same tools while working inside a campaign, but the admin version is the server-wide source of truth.

---

## Docker

```bash
docker compose up --build
```

The container serves both the built React app and the API on port `8790`. Campaign data mounts from `./data`.

To include local Whisper support (adds ~5 GB to image size):

```bash
./install.sh install-asr
```

---

## Authentication

Two layers work together:

**Server-level accounts** (stored in `data/secrets/admin-auth.json`)
- Admin, DM, and Player accounts with username + password
- Sessions last 30 days
- Players can self-register at `/login` — they won't see anything until a DM invites them to a campaign

**Campaign-level sessions** (stored in each campaign's SQLite)
- Issued when a player joins a campaign via invite code
- Scoped to that campaign
- Linked back to the player's server account via `server_user_id`

### Recovering admin access

```bash
npm run admin:reset
```

---

## Transcript Pipeline

Upload a session audio file or plain text transcript. The pipeline:

1. **Transcribes** audio via the configured ASR provider
2. **Diarizes** speakers (via pyannote or LLM-based heuristics)
3. **Extracts** NPC updates, quest changes, quotes, and a journal entry using the configured LLM
4. **Stages** everything in the approval queue — nothing becomes canon until the DM approves

### ASR Providers

| Provider | Notes |
|----------|-------|
| `remote` | SSH to a GPU host running Whisper (default) |
| `local` | Whisper CLI inside the container |
| `whisper-local` | Local Whisper HTTP API. Supports OpenAI-compatible APIs or a simple `/transcribe` wrapper with an API key header. |
| `groq` | Groq Cloud — free, fast. Requires `GROQ_API_KEY` |
| `openai` | OpenAI whisper-1. Requires `OPENAI_API_KEY` |

**Example local setup** for `whisper-local` with an existing Whisper wrapper:

```bash
ASR_PROVIDER=whisper-local
WHISPER_LOCAL_BASE=http://ollama.middl.earth.arda:8765
WHISPER_LOCAL_PATH=/transcribe
WHISPER_LOCAL_MODEL=large-v3
WHISPER_LOCAL_API_KEY=your-key-here
WHISPER_LOCAL_API_KEY_HEADER=X-API-Key
```

The app posts audio with form field `file` and expects `{ text, segments }` back.

### LLM Providers

Ollama, OpenAI, Anthropic, and Google Gemini are all supported. Switch between them in the Admin Console or campaign Settings without restarting.

For local/self-hosted use, Ollama is the default. The current example config points at:

```bash
OLLAMA_BASE=http://ollama.middl.earth.arda:11434
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5:7b
```

Chat subscriptions such as ChatGPT Plus/Pro or Claude Pro/Max are not API credentials for this server app. Use provider API keys, Ollama, or another API-compatible gateway.

---

## Lexicon & Canon

Each campaign keeps its own canon entries. Each entry has:

- **Kind** — `npc`, `monster`, `place`, `quest`, `item`, `faction`, or `term`
- **Creature type** — the D&D creature type (humanoid, undead, dragon, etc.) for NPCs and monsters
- **Role**, **relation**, **aliases**, **notes**

NPCs and monsters are distinct by role, not type — the same goblin can be an NPC when negotiating and a monster in combat. Both share the same 14 D&D creature types.

---

## Data Layout

```
data/
  secrets/
    admin-auth.json        # server accounts and sessions
  campaigns/
    <campaign-id>/
      meta.json            # name, owner, created date
      campaign.sqlite      # all campaign data
      sessions/            # raw session snapshots
      imports/             # pipeline import artifacts
      exports/             # JSON exports
      backups/             # SQLite backups
```

---

## Backup and Export

From the Admin Console (Campaigns tab):

- **Backup** — writes a SQLite backup + manifest to `data/campaigns/<id>/backups/`
- **Download Export** — downloads a full JSON export of campaign state
- **Write Export** — writes a JSON export into `data/campaigns/<id>/exports/`
- **Storage Check** — checks SQLite-backed canonical data, journal, trackers, and bard tales

From the campaign Settings page (DM):

- Download Export — streams JSON to browser
- Write Export File — saves to server filesystem
- Create Backup — SQLite backup on server

---

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `8790` | Listening port |
| `DATA_DIR` | `./data` | Campaign data root |
| `CORS_ORIGINS` | localhost only | Comma-separated allowed origins |
| `MAX_UPLOAD_BYTES` | 200 MB | Max file upload size |
| `MAX_CONCURRENT_JOBS` | `3` | Parallel transcription jobs |
| `LLM_PROVIDER` | `ollama` | `ollama` \| `openai` \| `anthropic` \| `gemini` |
| `LLM_MODEL` | `qwen2.5:7b` | Model name for the selected provider |
| `ASR_PROVIDER` | `remote` | `remote` \| `local` \| `whisper-local` \| `groq` \| `openai` |
| `WHISPER_LOCAL_BASE` | `http://ollama.middl.earth.arda:8765` | Base URL for `whisper-local` provider |
| `WHISPER_LOCAL_PATH` | `/transcribe` | Transcription endpoint path |
| `WHISPER_LOCAL_API_KEY_HEADER` | `X-API-Key` | Header used when `WHISPER_LOCAL_API_KEY` is set |
| `DIARIZATION_MODE` | `auto` | `auto` \| `llm` \| `pyannote` |

See `.env.example` for the full list.

---

## Development Notes

- The frontend is React 19 + Vite 8 + Tailwind CSS 4
- The API is Express 5 on Node.js (ESM)
- The app uses SQLite via Node's built-in `node:sqlite` (experimental, Node 22+)
- `server_legacy.js` contains the main pipeline logic — the modular server imports it and will split it out over time
- Jobs live in memory — a server restart clears running jobs. Re-run the pipeline if that happens.
- Terminal job snapshots are persisted to `data/jobs.sqlite` so completed/error/cancelled jobs can still be inspected after restart.
- Runtime secrets and local campaign data are ignored by git via `.gitignore`.

---

## Troubleshooting

### Pipeline finishes but no approval appears

Open the DM campaign desk and check the **Review** tab. Completed imports create a pending proposal in the Approval Queue. If the UI was open before the job finished, refresh campaign state or reload the page.

### Ollama returns HTTP 500 or times out

Use Admin Console -> Diagnostics to confirm Ollama is reachable, then switch the LLM model in Admin Settings. Smaller local models such as `qwen2.5:7b` are often more reliable for quick testing than larger custom models.

### Whisper-local auth fails

Confirm these settings in Admin Settings:

- `WHISPER_LOCAL_BASE`
- `WHISPER_LOCAL_PATH`
- `WHISPER_LOCAL_MODEL`
- `WHISPER_LOCAL_API_KEY_HEADER`
- API key value

The current wrapper expects:

```bash
POST /transcribe
Header: X-API-Key: <key>
Form field: file=@audio.mp3
```

### Admin password forgotten

Run:

```bash
npm run admin:reset
```
