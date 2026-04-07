# D&D Dashboard — Lexicon Ownership & Linkage Architecture (v1 Draft)

**Status:** Draft for morning review  
**Author:** claw  
**Date:** 2026-03-18

---

## 1) Problem Statement

Current behavior allows drift between:
- `lexicon.json` (edited canon terms)
- `quests.json` / `npcs.json` / `places.json` (tracker data)

This creates issues such as:
- edits in Lexicon not reflected in trackers
- `UNKNOWN` objects becoming orphaned or uneditable in expected places
- duplicate entities representing the same thing

---

## 2) Core Principle

## **Lexicon is the canonical source of truth.**

Trackers (Quest/NPC/Place/Event views) are **derived/indexed views** linked back to Lexicon objects, not independent canonical stores.

In short:
- Canon object lives once (Lexicon)
- Tracker entries reference canon object by ID
- AI + human updates merge into canonical object using field-level ownership rules

---

## 3) Object Model

### 3.1 Canonical Lexicon Object

Each lexicon object should have a stable identity and typed payload.

```json
{
  "id": "lex_01HV...",
  "entityType": "quest|npc|place|event|item|faction|term",
  "term": "Festival of the Blazing Sun",
  "aliases": ["blazing sun festival"],
  "notes": "...",

  "quest": {
    "status": "Active|Pending|Completed|Blocked",
    "objective": "...",
    "reward": "...",
    "leads": ["..."],
    "latestUpdate": "..."
  },

  "npc": {
    "role": "...",
    "relation": "...",
    "latestUpdate": "..."
  },

  "place": {
    "type": "town|dungeon|landmark|...",
    "tags": ["..."]
  },

  "ownership": {
    "dmLockedFields": ["term", "aliases", "entityType"],
    "aiMutableFields": ["notes", "quest.status", "quest.latestUpdate", "npc.latestUpdate"]
  },

  "provenance": {
    "createdBy": "ai|dm|player|import",
    "lastUpdatedBy": "ai|dm|player|import",
    "lastSourceType": "audio|transcript|manual|module-import|data-browser",
    "lastSourceId": "..."
  },

  "createdAt": 1773800000000,
  "updatedAt": 1773801000000
}
```

### 3.2 Tracker Entry (View Index)

Tracker rows can remain physically stored for compatibility/perf, but are references:

```json
{
  "id": "trk_q_01",
  "trackerType": "quest",
  "lexiconId": "lex_01HV...",
  "displayName": "Festival of the Blazing Sun",
  "snapshot": {
    "status": "Active",
    "subtitle": "Recover missing relic"
  },
  "updatedAt": 1773801000000
}
```

> Long-term: trackers can be computed dynamically from lexicon; short-term keep cached projection.

---

## 4) Ownership & Merge Rules

We need field-level ownership, not binary human-vs-AI ownership.

## 4.1 DM-canonical fields (high authority)
- `term` (canonical spelling/name)
- `aliases`
- `entityType`
- disambiguation decisions (e.g., UNKNOWN resolved to known object)

AI should not silently overwrite these.

## 4.2 AI-progression fields (session evolution)
- quest status progression
- latest updates
- event progression notes
- non-canonical descriptive notes

AI can update these when linked to a canonical object.

## 4.3 Conflict behavior
- If AI update touches DM-locked field:
  - queue for review instead of auto-apply
- If AI update touches mutable field:
  - apply with provenance stamp
- If uncertain identity:
  - hold as candidate + require link/resolve

---

## 5) UNKNOWN Resolution Strategy

### Current pain:
AI emits `UNKNOWN` quest/NPC then it drifts separately.

### New behavior:
1. Candidate unresolved object created as lexicon object with `term="UNKNOWN"` + context evidence.
2. DM resolves by:
   - renaming term, OR
   - linking candidate to an existing lexicon object
3. System stores alias mapping and/or direct link so future AI updates map correctly.

Suggested helper table:

```json
{
  "alias": "unknown vineyard quest",
  "lexiconId": "lex_01HV...",
  "confidence": 0.91,
  "source": "dm-resolution"
}
```

---

## 6) Write Path (AI Ingest) — New Flow

For each extracted candidate (quest/npc/place/event):

1. **Identity resolution**
   - canonical name match
   - alias match
   - fuzzy fallback (thresholded)
2. **Upsert canonical lexicon object**
3. **Apply merge policy by field ownership**
4. **Update/create tracker reference row** with `lexiconId`
5. **Record provenance + evidence**

No tracker write should happen without a corresponding lexicon object.

---

## 7) Read Path (UI)

### 7.1 Lexicon page
- Edit canonical objects directly
- Expose lock/mutable status for transparency

### 7.2 Tracker pages
- Render from linked lexicon + projection
- “Edit in Lexicon” action always available
- If unresolved/ambiguous, show “Resolve Link” action

---

## 8) API Changes (proposed)

## Canon
- `PUT /api/campaigns/:id/lexicon/:termId` (existing, upgraded semantics)
- `POST /api/campaigns/:id/lexicon/resolve-link` (new)
- `POST /api/campaigns/:id/lexicon/alias` (new)

## Trackers
- `GET /api/campaigns/:id/trackers/:type` returns linked rows + canon refs
- Optional compatibility endpoints still supported during migration

## Rebuild/Repair
- `POST /api/campaigns/:id/rebuild-trackers-from-lexicon`

---

## 9) Migration Plan (safe staged)

### Phase 0 — No-break prep
- Add `entityType`, ownership/provenance fields to lexicon entries
- Add `lexiconId` to tracker rows where possible

### Phase 1 — Backfill links
- Build matching pass quest/npc/place tracker -> lexicon
- Produce unresolved report for manual resolve

### Phase 2 — Write path cutover
- AI ingest writes lexicon first, then tracker links
- block independent tracker-only creates

### Phase 3 — UI cutover
- tracker edit actions route to lexicon object edits or guided resolve

### Phase 4 — Optional simplification
- deprecate separate canonical fields in `quests/npcs/places` and keep as projection cache

---

## 10) Acceptance Criteria

1. Editing a quest term in Lexicon updates Quest Tracker view consistently.
2. AI updates after a manual rename continue updating the same canonical object.
3. No new `UNKNOWN` duplicate created after resolve+alias.
4. Every tracker row has valid `lexiconId`.
5. Tracker and lexicon show consistent status/objective/update fields.

---

## 11) Risks & Mitigations

- **Risk:** bad auto-link merges distinct entities
  - Mitigation: confidence threshold + review queue for borderline matches
- **Risk:** legacy data inconsistencies
  - Mitigation: one-time backfill report + manual resolution UI
- **Risk:** temporary dual-write complexity
  - Mitigation: staged rollout with rebuild endpoint and revert path

---

## 12) Recommended Immediate Next Step

Implement a **thin vertical slice** first:
1. Quest objects only (`entityType=quest`)
2. Lexicon-owned write path for quest updates
3. Quest tracker rows linked by `lexiconId`
4. “Resolve UNKNOWN quest” UI action

Then replicate same pattern for NPC and Place.

---

## 13) Out of Scope (for this pass)

- Full event graph/relationship engine
- aggressive fuzzy entity merging across all types
- permission model beyond DM-vs-AI field ownership

---

If approved in the morning, implementation can proceed in controlled phases without breaking existing workflow.

---

## 14) v1.1 Refinements (Applied from review notes)

These refinements are adopted for implementation planning.

### 14.1 Naming clarity
- UI keeps the label **Lexicon**.
- Backend mental model is **canonical entity registry**.

### 14.2 Canon object schema tightening
- Canon object keeps one typed payload field:
  - `data` (shape validated by `entityType`)
- Enforce invariant: payload must match `entityType`.

Example (quest):
```json
{
  "id": "lex_...",
  "entityType": "quest",
  "term": "Festival of the Blazing Sun",
  "aliases": ["blazing sun festival"],
  "notes": "...",
  "data": {
    "status": "Active",
    "objective": "...",
    "reward": "...",
    "leads": ["..."],
    "latestUpdate": "..."
  }
}
```

### 14.3 Resolution state (do not rely on literal UNKNOWN)
Add explicit resolution metadata:
```json
"resolution": {
  "state": "resolved|candidate|ambiguous",
  "resolvedToLexiconId": null
}
```

### 14.4 Alias mapping is first-class
Introduce dedicated alias mapping objects/table:
```json
{
  "id": "alias_01",
  "entityType": "quest",
  "alias": "unknown vineyard quest",
  "lexiconId": "lex_01HV...",
  "confidence": 0.91,
  "source": "dm-resolution",
  "createdAt": 1773801000000
}
```

### 14.5 Evidence refs included now
Canonical objects include lightweight evidence list:
```json
"evidence": [
  {
    "sourceType": "transcript",
    "sourceId": "session_04",
    "excerpt": "We need to restore the wine supply.",
    "lineRefs": ["line_182", "line_191"]
  }
]
```

### 14.6 Ownership modes (3-state)
For merge safety, use ownership modes:
- `locked`
- `mutable`
- `append_only_review`

Recommended defaults:
- `term`, `entityType`: `locked`
- `aliases`: `append_only_review`
- `data.status`, `data.latestUpdate`: `mutable`
- list fields like `leads`, `tags`: `append_only_review`

### 14.7 Tracker snapshot semantics
Snapshot is **display cache only**, never canonical source.

> `snapshot` is a denormalized view derived from linked lexicon entities and must not be treated as independent truth.

### 14.8 Link quality metadata during migration
Tracker linkage records should include:
- `linkConfidence`
- `linkMethod` (`exact-term|alias|fuzzy|manual`)

### 14.9 API naming consistency
Use stable ID naming in routes:
- prefer `:lexiconId` over `:termId`

### 14.10 Acceptance criteria additions
Add criterion:
- Renaming a canonical entity does not break tracker links, aliases, or future AI updates.

---

## 15) Morning Decision Gate (short form)

**Approve direction. Implement quests first. Add resolution state + alias table before coding.**

---

## 16) Implementation Order + SQL Shape (approved)

Follow this implementation order:

1. `lexicon_entities`
2. `entity_aliases`
3. `tracker_rows`
4. `journal_entries`
5. `bard_tales`

Keep transcription/pipeline artifact storage file-based or blob-based for now (out of relational core).

### 16.1 `lexicon_entities`
- `id`
- `campaign_id`
- `entity_type`
- `canonical_term`
- `notes`
- `resolution_state`
- `created_by`
- `last_updated_by`
- `last_source_type`
- `last_source_id`
- `created_at`
- `updated_at`

### 16.2 `entity_aliases`
- `id`
- `entity_id`
- `alias`
- `confidence`
- `source`
- `created_at`

### 16.3 `tracker_rows`
- `id`
- `campaign_id`
- `tracker_type`
- `entity_id`
- `snapshot_json`
- `link_method`
- `link_confidence`
- `updated_at`

### 16.4 `journal_entries`
- `id`
- `campaign_id`
- `session_id`
- `title`
- `body`
- `source_hash`
- `created_at`
- `updated_at`

### 16.5 `bard_tales`
- `id`
- `journal_entry_id`
- `title`
- `bard_name`
- `persona_id`
- `faithfulness`
- `prompt_version`
- `source_hash`
- `source_length`
- `text`
- `created_at`

This section defines direction and table shape, not full DDL.
