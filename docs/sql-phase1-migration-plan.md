# D&D Dashboard — SQL Migration Plan (Phase 1: Quest Vertical Slice)

Date: 2026-03-18
Status: Implemented (phase 2 in progress)

## Why this split

Relational truth goes in SQL; large/raw pipeline artifacts stay file-based for now.

## SQL tables (relational core)

Implemented in `campaign.sqlite` per campaign:

- `lexicon_entities`
- `entity_aliases`
- `tracker_rows`
- `journal_entries` (schema staged)
- `bard_tales` (schema staged)

## Current phase scope

Phase 1 (active):
- Quest tracker read path can come from SQL via `GET /api/campaigns/:id/trackers/quest`.
- Canonical in-memory/json stores are mirrored into SQL on state load and key write paths.
- Lexicon add/edit/resolve/alias/delete sync SQL.
- Proposal apply path syncs canonical quest tracker linkage into SQL.

Compatibility kept:
- Existing JSON files remain source-compatible during cutover.
- Non-quest trackers still return via JSON compatibility path.

## DDL shape

`lexicon_entities`
- `id TEXT PRIMARY KEY`
- `campaign_id TEXT NOT NULL`
- `entity_type TEXT NOT NULL`
- `canonical_term TEXT NOT NULL`
- `notes TEXT NOT NULL DEFAULT ''`
- `resolution_state TEXT NOT NULL DEFAULT 'resolved'`
- `created_by TEXT NOT NULL DEFAULT 'import'`
- `last_updated_by TEXT NOT NULL DEFAULT 'import'`
- `last_source_type TEXT NOT NULL DEFAULT ''`
- `last_source_id TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `UNIQUE(campaign_id, entity_type, canonical_term)`

`entity_aliases`
- `id TEXT PRIMARY KEY`
- `entity_id TEXT NOT NULL REFERENCES lexicon_entities(id) ON DELETE CASCADE`
- `alias TEXT NOT NULL`
- `confidence REAL NOT NULL DEFAULT 1`
- `source TEXT NOT NULL DEFAULT 'import'`
- `created_at INTEGER NOT NULL`
- `UNIQUE(entity_id, alias)`

`tracker_rows`
- `id TEXT PRIMARY KEY`
- `campaign_id TEXT NOT NULL`
- `tracker_type TEXT NOT NULL`
- `entity_id TEXT NOT NULL REFERENCES lexicon_entities(id) ON DELETE CASCADE`
- `snapshot_json TEXT NOT NULL DEFAULT '{}'`
- `link_method TEXT NOT NULL DEFAULT 'manual'`
- `link_confidence REAL NOT NULL DEFAULT 1`
- `updated_at INTEGER NOT NULL`

`journal_entries` and `bard_tales` tables are created as staged schema for next phase.

## Guardrails

- Foreign keys enabled (`PRAGMA foreign_keys=ON`).
- Tracker rows require valid `entity_id`.
- Alias rows require valid `entity_id`.
- Delete cascades clean alias/tracker rows linked to entity.

## Phase 2 update (completed now)

- Journal writes are mirrored to SQL (`journal_entries`) on:
  - proposal apply,
  - journal edit,
  - state hydration backfill.
- Bard tale writes are mirrored to SQL (`bard_tales`) on create; deletes remove SQL rows.
- Tracker reads for `quest`, `npc`, and `place` now use SQL path; `event` remains compatibility path.

## Phase 3 update (completed now)

- Canonical entities, aliases, tracker rows, journal entries, bard tales, and campaign metadata documents are now SQLite-first.
- The diagnostics endpoint remains at `GET /api/campaigns/:id/sql-parity`, but it now reports SQLite-backed counts and hashes rather than JSON-vs-SQL parity.
- The transitional `SQL_PRIMARY_*` flags were removed after the SQLite-first cutover was completed.

## Next phase

1. Surface the export/backup operations in the UI if operators need them without calling the API directly.
2. Review whether `meta.json` should remain filesystem-based or move into SQLite later.
3. Consider moving import/session artifact indexing into SQLite while keeping the files themselves on disk.

## Rollback

- Restore from a SQLite backup in `backups/` or from an explicit export if rollback is needed.
- Filesystem artifacts in `sessions/` and `imports/` remain available even if database state needs to be restored separately.
