# D&D Dashboard — Phase 4 SQL Hard Cutover Plan

Date: 2026-03-18
Owner: claw
Status: Proposed for morning review

---

## Objective

Make SQL the single source of truth for canonical domain state.

**Rule:** Database is the boss. JSON is export/backup only.

---

## Scope (hard cut)

Canonical writable truth moves to SQL only:
- `lexicon_entities`
- `entity_aliases`
- `tracker_rows`
- `journal_entries`
- `bard_tales`

JSON files remain for:
- backup/snapshot export
- debugging/audit

JSON files stop being runtime authority.

---

## Current deltas to eliminate

1. Hybrid write paths (SQL + JSON mutations)
2. JSON fallback reads in core runtime paths
3. Name-based fallback identity (`normalized term`) in mutation logic
4. Legacy backfill behavior affecting tracker membership policy
5. Mixed-ID projection behavior causing “unknown” labels and checkbox mismatch

---

## Implementation steps

## Step 1 — SQL authority declaration in code
- Add explicit cutover constant: `SQL_HARD_CUTOVER=true`
- Guard all canonical read/write code paths behind this constant.
- When enabled:
  - no JSON fallback for canonical decisions
  - no name-based identity fallback for mutations

## Step 2 — SQL-only writes
Refactor these endpoint families to SQL-first and SQL-only canonical writes:
- Lexicon CRUD
- Alias/resolve-link routes
- Tracker membership toggles
- Journal edit/delete
- Bard tale create/delete
- Approval merge canonical updates

JSON write behavior after this step:
- remove inline mutation writes
- optional async exporter writes snapshots from SQL state

## Step 3 — SQL-only reads
Refactor state assembly so canonical sections are built from SQL only:
- lexicon list from `lexicon_entities`
- tracker panels from `tracker_rows + lexicon_entities`
- journal from `journal_entries`
- bard tales from `bard_tales`

JSON data should no longer be consulted for canonical display or linkage.

## Step 4 — Remove legacy backfill side effects
- Keep a one-time migration entrypoint for historical import only.
- Disable runtime legacy membership auto-backfill.
- Tracker membership policy = explicit opt-in by canonical ID and type-safe toggles.

## Step 5 — One-time migration + parity gate
Before final flip:
1. Run idempotent migration JSON -> SQL (if needed)
2. Generate parity report (counts + hash spot checks)
3. Check integrity:
   - no orphan tracker rows
   - tracker type/entity type match
   - no duplicate canonical IDs
4. Snapshot backup before enabling hard cut

## Step 6 — JSON exporter
Add one explicit exporter command/endpoint:
- Reads SQL state
- Writes canonical JSON snapshots
- Never used for runtime mutation/read decisions

---

## API behavior changes (expected)

- Mutations require canonical IDs.
- No fallback by term/name for canonical updates.
- Errors become explicit:
  - `entityId required`
  - `canonical entity not found`

---

## Acceptance criteria (must pass)

1) **Rename propagation**
- Renaming canonical entity updates projections with no duplicate/orphan rows.

2) **Delete semantics**
- Deleting canonical entity handles linked tracker rows deterministically.

3) **Tracker membership**
- Checkbox toggles create/remove tracker rows by canonical ID only.
- Type-safe (npc->npc tracker, quest->quest tracker, place->place tracker only).

4) **No unknown labels when canonical exists**
- Tracker display resolves from canonical entities by ID only.

5) **No legacy fallback identity**
- No term-based mutation fallback remains in canonical paths.

6) **Parity + integrity clean**
- SQL parity report green for canonical domains.
- No orphan tracker rows.

---

## Rollback plan

- Take pre-cutover backup snapshot.
- Keep exporter snapshots versioned.
- If regression appears:
  - disable `SQL_HARD_CUTOVER`
  - restore from backup
  - re-run parity diagnostics before reattempt

---

## Morning discussion checklist

- Confirm “SQL-only runtime authority” decision.
- Confirm tracker membership policy (explicit toggle only).
- Confirm migration window and rollback window.
- Confirm whether JSON exporter should be manual or scheduled.
- Approve acceptance criteria as release gate.
