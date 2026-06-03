/**
 * Campaign service — all campaign domain logic: SQLite models, canonical stores,
 * lexicon, journal, bard tales, game sessions, approval workflow, export/backup.
 *
 * This module is the source of truth for filesystem + SQLite persistence.
 * Postgres dual-writes happen here too (async, best-effort).
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import {
  DATA_DIR, CAMPAIGNS_DIR, CAMPAIGN_DB_CACHE_MAX, BARD_PROMPT_VERSION,
} from '../config.js'

import { db as pgDb } from '../db/postgres/pool.js'
import { findCampaignBySlug } from '../db/postgres/repositories/campaigns.repo.js'
import * as lexiconRepo from '../db/postgres/repositories/lexicon.repo.js'
import * as journalRepo from '../db/postgres/repositories/journal.repo.js'
import * as bardTalesRepo from '../db/postgres/repositories/bard-tales.repo.js'
import * as campaignDocumentsRepo from '../db/postgres/repositories/campaign-documents.repo.js'

import {
  InvalidCampaignIdError, CampaignNotFoundError, DataIntegrityError,
  normalizeCampaignId, resolveCampaignBase, slugify,
  runWithCampaignWriteLock, runExclusive, withStaticWriteLock,
  withCampaignParamWriteLock, withCampaignBodyWriteLock,
  readJson, writeJson, sourceHashForText as _srcHash,
} from '../utils.js'

export {
  InvalidCampaignIdError, CampaignNotFoundError, DataIntegrityError,
  normalizeCampaignId, resolveCampaignBase, slugify,
  runWithCampaignWriteLock, runExclusive, withStaticWriteLock,
  withCampaignParamWriteLock, withCampaignBodyWriteLock,
  readJson, writeJson,
}

// ── Postgres campaign ID cache (slug → UUID) ──────────────────────────────────

const _pgIdCache = new Map()

export async function getPgCampaignId(slug) {
  if (_pgIdCache.has(slug)) return _pgIdCache.get(slug)
  try {
    const campaign = await findCampaignBySlug(slug)
    if (campaign) _pgIdCache.set(slug, campaign.id)
    return campaign?.id ?? null
  } catch {
    return null
  }
}

// ── Source hash ───────────────────────────────────────────────────────────────

export function normalizeSourceForHash(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function sourceHashForText(text = '') {
  return crypto.createHash('sha256').update(normalizeSourceForHash(text), 'utf8').digest('hex')
}

export function parityHashRows(rows = [], keyFn = (x) => x) {
  const payload = (Array.isArray(rows) ? rows : []).map(keyFn).sort()
  return sourceHashForText(JSON.stringify(payload))
}

// ── SQLite LRU cache ──────────────────────────────────────────────────────────

const campaignDbCache = new Map() // key → { db, lruOrder }
let _lruSeq = 0
const _schemaMigratedDbs = new WeakSet()

export function dbForCampaignBase(base) {
  const dbPath = path.join(base, 'campaign.sqlite')
  if (campaignDbCache.has(dbPath)) {
    campaignDbCache.get(dbPath).lruOrder = ++_lruSeq
    return campaignDbCache.get(dbPath).db
  }
  // Evict least-recently-used if at capacity
  if (campaignDbCache.size >= CAMPAIGN_DB_CACHE_MAX) {
    let oldest = null
    for (const [k, v] of campaignDbCache) {
      if (!oldest || v.lruOrder < campaignDbCache.get(oldest).lruOrder) oldest = k
    }
    if (oldest) {
      try { campaignDbCache.get(oldest).db.close() } catch { /* ignore */ }
      campaignDbCache.delete(oldest)
    }
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  campaignDbCache.set(dbPath, { db, lruOrder: ++_lruSeq })
  // Run schema migrations once immediately on first open.
  ensureSqlSchema(db)
  return db
}

function ensureSqlSchema(db) {
  // Guard: only run migrations once per connection instance.
  if (_schemaMigratedDbs.has(db)) return
  _schemaMigratedDbs.add(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lexicon_entities (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      canonical_term TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      resolution_state TEXT NOT NULL DEFAULT 'resolved',
      resolved_to_lexicon_id TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      ownership_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT 'import',
      last_updated_by TEXT NOT NULL DEFAULT 'import',
      last_source_type TEXT NOT NULL DEFAULT '',
      last_source_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(campaign_id, entity_type, canonical_term)
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'import',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(entity_id) REFERENCES lexicon_entities(id) ON DELETE CASCADE,
      UNIQUE(entity_id, alias)
    );

    CREATE TABLE IF NOT EXISTS tracker_rows (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      tracker_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      link_method TEXT NOT NULL DEFAULT 'manual',
      link_confidence REAL NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(entity_id) REFERENCES lexicon_entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bard_tales (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      journal_entry_id TEXT,
      title TEXT NOT NULL,
      bard_name TEXT,
      persona_id TEXT,
      faithfulness TEXT,
      prompt_version TEXT,
      source_hash TEXT,
      source_length INTEGER,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_documents (
      campaign_id TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      content_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (campaign_id, doc_key)
    );

    CREATE INDEX IF NOT EXISTS idx_lexicon_entities_campaign_type ON lexicon_entities(campaign_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_lexicon_entities_campaign_term ON lexicon_entities(campaign_id, canonical_term);
    CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_campaign_type ON tracker_rows(campaign_id, tracker_type);
    CREATE INDEX IF NOT EXISTS idx_campaign_documents_campaign ON campaign_documents(campaign_id, doc_key);
  `)

  try {
    db.exec('ALTER TABLE bard_tales ADD COLUMN campaign_id TEXT')
  } catch {
    // column already exists or table shape already updated
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_bard_tales_campaign ON bard_tales(campaign_id, created_at)')
  } catch {
    // ignore
  }

  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN resolved_to_lexicon_id TEXT") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}'") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN ownership_json TEXT NOT NULL DEFAULT '{}'") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'") } catch {}
}

export function runInTx(db, fn) {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

// ── SQLite model functions ────────────────────────────────────────────────────

function sqlUpsertCanonicalFromMemory(db, campaignId, canon) {
  ensureSqlSchema(db)
  const entities = Array.isArray(canon?.entities) ? canon.entities : []
  const aliases = Array.isArray(canon?.aliases) ? canon.aliases : []
  const trackerRows = Array.isArray(canon?.trackerRows) ? canon.trackerRows : []

  const deleteEntities = db.prepare('DELETE FROM lexicon_entities WHERE campaign_id = ?')

  const upsertEntity = db.prepare(`
    INSERT INTO lexicon_entities (
      id, campaign_id, entity_type, canonical_term, notes, resolution_state,
      resolved_to_lexicon_id, data_json, ownership_json, evidence_json,
      created_by, last_updated_by, last_source_type, last_source_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      entity_type=excluded.entity_type,
      canonical_term=excluded.canonical_term,
      notes=excluded.notes,
      resolution_state=excluded.resolution_state,
      resolved_to_lexicon_id=excluded.resolved_to_lexicon_id,
      data_json=excluded.data_json,
      ownership_json=excluded.ownership_json,
      evidence_json=excluded.evidence_json,
      last_updated_by=excluded.last_updated_by,
      last_source_type=excluded.last_source_type,
      last_source_id=excluded.last_source_id,
      updated_at=excluded.updated_at
  `)

  const upsertAlias = db.prepare(`
    INSERT INTO entity_aliases (id, entity_id, alias, confidence, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id, alias) DO UPDATE SET
      confidence=excluded.confidence,
      source=excluded.source
  `)

  const upsertTracker = db.prepare(`
    INSERT INTO tracker_rows (id, campaign_id, tracker_type, entity_id, snapshot_json, link_method, link_confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tracker_type=excluded.tracker_type,
      entity_id=excluded.entity_id,
      snapshot_json=excluded.snapshot_json,
      link_method=excluded.link_method,
      link_confidence=excluded.link_confidence,
      updated_at=excluded.updated_at
  `)

  runInTx(db, () => {
    deleteEntities.run(campaignId)

    for (const e of entities) {
      upsertEntity.run(
        String(e?.id || crypto.randomUUID()),
        campaignId,
        normalizeEntityType(e?.entityType || 'term'),
        String(e?.canonicalTerm || '').trim(),
        String(e?.notes || '').trim(),
        String(e?.resolution?.state || 'resolved').trim() || 'resolved',
        e?.resolution?.resolvedToLexiconId ? String(e.resolution.resolvedToLexiconId) : null,
        JSON.stringify(e?.data || {}),
        JSON.stringify(e?.ownership || {}),
        JSON.stringify(Array.isArray(e?.evidence) ? e.evidence : []),
        String(e?.createdBy || 'import').trim(),
        String(e?.lastUpdatedBy || 'import').trim(),
        String(e?.lastSourceType || '').trim(),
        e?.lastSourceId ? String(e.lastSourceId) : null,
        Number(e?.createdAt || Date.now()),
        Number(e?.updatedAt || Date.now()),
      )
    }

    for (const a of aliases) {
      const alias = String(a?.alias || '').trim()
      const entityId = String(a?.entityId || '').trim()
      if (!alias || !entityId) continue
      upsertAlias.run(
        String(a?.id || crypto.randomUUID()),
        entityId,
        alias,
        Number(a?.confidence ?? 1),
        String(a?.source || 'import').trim(),
        Number(a?.createdAt || Date.now()),
      )
    }

    for (const row of trackerRows) {
      const entityId = String(row?.entityId || '').trim()
      if (!entityId) continue
      upsertTracker.run(
        String(row?.id || crypto.randomUUID()),
        campaignId,
        String(row?.trackerType || '').trim(),
        entityId,
        JSON.stringify(row?.snapshot || {}),
        String(row?.linkMethod || 'manual').trim(),
        Number(row?.linkConfidence ?? 1),
        Number(row?.updatedAt || Date.now()),
      )
    }
  })
}

function sqlLoadCanonicalStores(db, campaignId) {
  ensureSqlSchema(db)

  const entityRows = db.prepare(`
    SELECT
      id, campaign_id, entity_type, canonical_term, notes, resolution_state,
      resolved_to_lexicon_id, data_json, ownership_json, evidence_json,
      created_by, last_updated_by, last_source_type, last_source_id, created_at, updated_at
    FROM lexicon_entities
    WHERE campaign_id = ?
    ORDER BY created_at ASC, canonical_term ASC
  `).all(campaignId)

  const entities = entityRows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    entityType: row.entity_type,
    canonicalTerm: row.canonical_term,
    notes: row.notes || '',
    data: (() => { try { return JSON.parse(String(row.data_json || '{}')) } catch { return {} } })(),
    resolution: {
      state: row.resolution_state || 'resolved',
      resolvedToLexiconId: row.resolved_to_lexicon_id || null,
    },
    ownership: (() => { try { return JSON.parse(String(row.ownership_json || '{}')) } catch { return {} } })(),
    evidence: (() => { try { return JSON.parse(String(row.evidence_json || '[]')) } catch { return [] } })(),
    aliases: [],
    createdBy: row.created_by || 'import',
    lastUpdatedBy: row.last_updated_by || 'import',
    lastSourceType: row.last_source_type || '',
    lastSourceId: row.last_source_id || null,
    createdAt: Number(row.created_at || Date.now()),
    updatedAt: Number(row.updated_at || row.created_at || Date.now()),
  }))

  const aliases = db.prepare(`
    SELECT ea.id, ea.entity_id, ea.alias, ea.confidence, ea.source, ea.created_at, le.entity_type
    FROM entity_aliases ea
    JOIN lexicon_entities le ON le.id = ea.entity_id
    WHERE le.campaign_id = ?
    ORDER BY ea.created_at ASC, ea.alias ASC
  `).all(campaignId).map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    alias: row.alias,
    confidence: Number(row.confidence ?? 1),
    source: row.source || 'import',
    createdAt: Number(row.created_at || Date.now()),
  }))

  const aliasesByEntityId = new Map()
  for (const alias of aliases) {
    if (!aliasesByEntityId.has(alias.entityId)) aliasesByEntityId.set(alias.entityId, [])
    aliasesByEntityId.get(alias.entityId).push(alias.alias)
  }
  for (const entity of entities) {
    entity.aliases = Array.from(new Set(aliasesByEntityId.get(entity.id) || []))
  }

  const trackerRows = db.prepare(`
    SELECT id, campaign_id, tracker_type, entity_id, snapshot_json, link_method, link_confidence, updated_at
    FROM tracker_rows
    WHERE campaign_id = ?
    ORDER BY updated_at DESC, id ASC
  `).all(campaignId).map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    trackerType: row.tracker_type,
    entityId: row.entity_id,
    snapshot: (() => { try { return JSON.parse(String(row.snapshot_json || '{}')) } catch { return {} } })(),
    linkMethod: row.link_method || 'manual',
    linkConfidence: Number(row.link_confidence ?? 1),
    updatedAt: Number(row.updated_at || Date.now()),
  }))

  return { entities, aliases, trackerRows }
}

const CAMPAIGN_DOCUMENT_DEFS = {
  npcs: { fileKey: 'npcs', defaultValue: [] },
  quests: { fileKey: 'quests', defaultValue: [] },
  quotes: { fileKey: 'quotes', defaultValue: [] },
  storyJournal: { fileKey: 'storyJournal', defaultValue: { entries: [] } },
  pcs: { fileKey: 'pcs', defaultValue: [] },
  gameSessions: { fileKey: 'gameSessions', defaultValue: [] },
  approvals: { fileKey: 'approvals', defaultValue: [] },
  lexicon: { fileKey: 'lexicon', defaultValue: [] },
  places: { fileKey: 'places', defaultValue: [] },
  dmNotes: { fileKey: 'dmNotes', defaultValue: { text: '' } },
  dmSneakPeek: { fileKey: 'dmSneakPeek', defaultValue: [] },
  lexiconMeta: { fileKey: 'lexiconMeta', defaultValue: {} },
}

function cloneCampaignDocumentDefault(docKey) {
  const def = CAMPAIGN_DOCUMENT_DEFS[docKey]
  if (!def) throw new Error(`Unsupported campaign document: ${docKey}`)
  return JSON.parse(JSON.stringify(def.defaultValue))
}

function sqlLoadCampaignDocument(db, campaignId, docKey) {
  ensureSqlSchema(db)
  const row = db.prepare(`
    SELECT content_json
    FROM campaign_documents
    WHERE campaign_id = ? AND doc_key = ?
  `).get(campaignId, docKey)
  if (!row) return cloneCampaignDocumentDefault(docKey)
  try {
    return JSON.parse(String(row.content_json || 'null'))
  } catch (error) {
    throw new DataIntegrityError(`campaign_documents:${campaignId}:${docKey}`, error)
  }
}

function sqlUpsertCampaignDocument(db, campaignId, docKey, value) {
  ensureSqlSchema(db)
  db.prepare(`
    INSERT INTO campaign_documents (campaign_id, doc_key, content_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(campaign_id, doc_key) DO UPDATE SET
      content_json = excluded.content_json,
      updated_at = excluded.updated_at
  `).run(campaignId, docKey, JSON.stringify(value), Date.now())
}

export function sqlTrackerRowsByType(db, campaignId, type) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    SELECT
      tr.id, tr.campaign_id, tr.tracker_type, tr.entity_id, tr.snapshot_json, tr.link_method, tr.link_confidence, tr.updated_at,
      le.id AS le_id, le.entity_type, le.canonical_term, le.notes, le.resolution_state, le.resolved_to_lexicon_id,
      le.data_json, le.ownership_json, le.evidence_json, le.created_at AS le_created_at, le.updated_at AS le_updated_at
    FROM tracker_rows tr
    JOIN lexicon_entities le ON le.id = tr.entity_id
    WHERE tr.campaign_id = ? AND tr.tracker_type = ?
    ORDER BY tr.updated_at DESC
  `)
  return stmt.all(campaignId, type).map((r) => ({
    id: r.id,
    campaignId: r.campaign_id,
    trackerType: r.tracker_type,
    entityId: r.entity_id,
    snapshot: (() => { try { return JSON.parse(String(r.snapshot_json || '{}')) } catch { return {} } })(),
    linkMethod: r.link_method,
    linkConfidence: r.link_confidence,
    updatedAt: r.updated_at,
    entity: {
      id: r.le_id,
      entityType: r.entity_type,
      canonicalTerm: r.canonical_term,
      notes: r.notes,
      data: (() => { try { return JSON.parse(String(r.data_json || '{}')) } catch { return {} } })(),
      resolution: { state: r.resolution_state, resolvedToLexiconId: r.resolved_to_lexicon_id || null },
      ownership: (() => { try { return JSON.parse(String(r.ownership_json || '{}')) } catch { return {} } })(),
      evidence: (() => { try { return JSON.parse(String(r.evidence_json || '[]')) } catch { return [] } })(),
      createdAt: r.le_created_at,
      updatedAt: r.le_updated_at,
    },
  }))
}

function sqlUpsertJournalEntries(db, campaignId, entries = []) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    INSERT INTO journal_entries (id, campaign_id, session_id, title, body, source_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      body=excluded.body,
      source_hash=excluded.source_hash,
      updated_at=excluded.updated_at
  `)
  runInTx(db, () => {
    for (const e of (Array.isArray(entries) ? entries : [])) {
      const body = String(e?.markdown || e?.body || '')
      stmt.run(
        String(e?.id || crypto.randomUUID()),
        campaignId,
        e?.gameSessionId ? String(e.gameSessionId) : null,
        String(e?.title || '').trim() || 'Journal Entry',
        body,
        sourceHashForText(body),
        Number(e?.createdAt || Date.now()),
        Number(e?.updatedAt || e?.createdAt || Date.now()),
      )
    }
  })
}

function sqlLoadJournalEntries(db, campaignId) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    SELECT id, campaign_id, session_id, title, body, source_hash, created_at, updated_at
    FROM journal_entries
    WHERE campaign_id = ?
    ORDER BY created_at ASC
  `)
  return stmt.all(campaignId).map((r) => ({
    id: r.id,
    title: r.title,
    markdown: r.body,
    gameSessionId: r.session_id || null,
    createdAt: Number(r.created_at || Date.now()),
    updatedAt: Number(r.updated_at || r.created_at || Date.now()),
  }))
}

function sqlUpsertBardTales(db, campaignId, tales = []) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    INSERT INTO bard_tales (
      id, campaign_id, journal_entry_id, title, bard_name, persona_id, faithfulness,
      prompt_version, source_hash, source_length, text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      campaign_id=excluded.campaign_id,
      title=excluded.title,
      bard_name=excluded.bard_name,
      persona_id=excluded.persona_id,
      faithfulness=excluded.faithfulness,
      prompt_version=excluded.prompt_version,
      source_hash=excluded.source_hash,
      source_length=excluded.source_length,
      text=excluded.text
  `)
  runInTx(db, () => {
    for (const t of (Array.isArray(tales) ? tales : [])) {
      stmt.run(
        String(t?.id || crypto.randomUUID()),
        campaignId,
        t?.journalEntryId ? String(t.journalEntryId) : null,
        String(t?.title || t?.journalEntryTitle || 'The Tale').trim(),
        String(t?.bardName || '').trim() || null,
        String(t?.personaId || '').trim() || null,
        String(t?.faithfulness || '').trim() || null,
        String(t?.promptVersion || '').trim() || null,
        String(t?.sourceHash || '').trim() || null,
        Number(t?.sourceLength || 0),
        String(t?.text || t?.tale || ''),
        Number(t?.createdAt || Date.now()),
      )
    }
  })
}

function sqlLoadBardTales(db, campaignId) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    SELECT bt.id, bt.journal_entry_id, bt.title, bt.bard_name, bt.persona_id, bt.faithfulness,
           bt.prompt_version, bt.source_hash, bt.source_length, bt.text, bt.created_at,
           je.title AS journal_title
    FROM bard_tales bt
    LEFT JOIN journal_entries je ON je.id = bt.journal_entry_id
    WHERE bt.campaign_id = ?
    ORDER BY bt.created_at DESC
  `)
  return stmt.all(campaignId).map((r) => ({
    id: r.id,
    journalEntryId: r.journal_entry_id,
    journalEntryTitle: r.journal_title || 'The Tale',
    title: r.title,
    bardTitle: `${r.title || 'The Tale'} Bard's Tale`,
    bardName: r.bard_name || '',
    personaId: r.persona_id || 'grandiose',
    faithfulness: r.faithfulness || 'dramatic',
    promptVersion: r.prompt_version || BARD_PROMPT_VERSION,
    sourceHash: r.source_hash || '',
    sourceLength: Number(r.source_length || 0),
    text: r.text || '',
    tale: r.text || '',
    createdAt: Number(r.created_at || Date.now()),
    updatedAt: Number(r.created_at || Date.now()),
  }))
}

function sqlReplaceJournalEntries(db, campaignId, entries = []) {
  ensureSqlSchema(db)
  const deleteStmt = db.prepare('DELETE FROM journal_entries WHERE campaign_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO journal_entries (id, campaign_id, session_id, title, body, source_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      body=excluded.body,
      source_hash=excluded.source_hash,
      updated_at=excluded.updated_at
  `)
  runInTx(db, () => {
    deleteStmt.run(campaignId)
    for (const e of (Array.isArray(entries) ? entries : [])) {
      const body = String(e?.markdown || e?.body || '')
      insertStmt.run(
        String(e?.id || crypto.randomUUID()),
        campaignId,
        e?.gameSessionId ? String(e.gameSessionId) : null,
        String(e?.title || '').trim() || 'Journal Entry',
        body,
        sourceHashForText(body),
        Number(e?.createdAt || Date.now()),
        Number(e?.updatedAt || e?.createdAt || Date.now()),
      )
    }
  })
}

function sqlReplaceBardTales(db, campaignId, tales = []) {
  ensureSqlSchema(db)
  const deleteStmt = db.prepare('DELETE FROM bard_tales WHERE campaign_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO bard_tales (
      id, campaign_id, journal_entry_id, title, bard_name, persona_id, faithfulness,
      prompt_version, source_hash, source_length, text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      campaign_id=excluded.campaign_id,
      title=excluded.title,
      bard_name=excluded.bard_name,
      persona_id=excluded.persona_id,
      faithfulness=excluded.faithfulness,
      prompt_version=excluded.prompt_version,
      source_hash=excluded.source_hash,
      source_length=excluded.source_length,
      text=excluded.text
  `)
  runInTx(db, () => {
    deleteStmt.run(campaignId)
    for (const t of (Array.isArray(tales) ? tales : [])) {
      insertStmt.run(
        String(t?.id || crypto.randomUUID()),
        campaignId,
        t?.journalEntryId ? String(t.journalEntryId) : null,
        String(t?.title || t?.journalEntryTitle || 'The Tale').trim(),
        String(t?.bardName || '').trim() || null,
        String(t?.personaId || '').trim() || null,
        String(t?.faithfulness || '').trim() || null,
        String(t?.promptVersion || '').trim() || null,
        String(t?.sourceHash || '').trim() || null,
        Number(t?.sourceLength || 0),
        String(t?.text || t?.tale || ''),
        Number(t?.createdAt || Date.now()),
      )
    }
  })
}

// ── Campaign document helpers ─────────────────────────────────────────────────

export async function loadCampaignDocument(campaignId, base, docKey) {
  const db = dbForCampaignBase(base)
  return sqlLoadCampaignDocument(db, campaignId, docKey)
}

export async function persistCampaignDocument(campaignId, base, docKey, value) {
  const db = dbForCampaignBase(base)
  sqlUpsertCampaignDocument(db, campaignId, docKey, value)
  getPgCampaignId(campaignId).then((pgId) => {
    if (pgId) return campaignDocumentsRepo.upsertDocument(pgId, docKey, value)
  }).catch((err) => console.error(`[pg-dualwrite] campaign_documents ${campaignId}/${docKey}:`, err.message))
  return sqlLoadCampaignDocument(db, campaignId, docKey)
}

export async function loadCanonicalStoresSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadCanonicalStores(db, campaignId)
}

export async function persistCanonicalStoresSqlPrimary(campaignId, base, canon = {}) {
  const db = dbForCampaignBase(base)
  sqlUpsertCanonicalFromMemory(db, campaignId, canon)
  getPgCampaignId(campaignId).then((pgId) => {
    if (pgId) return lexiconRepo.replaceCanonicalStores(pgId, canon)
  }).catch((err) => console.error(`[pg-dualwrite] lexicon ${campaignId}:`, err.message))
  return sqlLoadCanonicalStores(db, campaignId)
}

export async function loadJournalEntriesSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadJournalEntries(db, campaignId)
}

export async function persistJournalEntriesSqlPrimary(campaignId, base, entries = []) {
  const allEntries = Array.isArray(entries) ? entries : []
  const MAX_JOURNAL_ENTRIES = 300
  if (allEntries.length > MAX_JOURNAL_ENTRIES) {
    console.warn(`[journal] campaign ${campaignId}: capping ${allEntries.length} entries to ${MAX_JOURNAL_ENTRIES} (oldest removed)`)
  }
  const nextEntries = allEntries.slice(-MAX_JOURNAL_ENTRIES)
  const db = dbForCampaignBase(base)
  sqlReplaceJournalEntries(db, campaignId, nextEntries)
  getPgCampaignId(campaignId).then((pgId) => {
    if (pgId) return journalRepo.replaceJournalEntries(pgId, nextEntries)
  }).catch((err) => console.error(`[pg-dualwrite] journal ${campaignId}:`, err.message))
  return sqlLoadJournalEntries(db, campaignId)
}

export async function loadBardTalesSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadBardTales(db, campaignId)
}

export async function persistBardTalesSqlPrimary(campaignId, base, tales = []) {
  const db = dbForCampaignBase(base)
  const nextTales = Array.isArray(tales) ? tales : []
  sqlReplaceBardTales(db, campaignId, nextTales)
  getPgCampaignId(campaignId).then((pgId) => {
    if (pgId) return bardTalesRepo.replaceBardTales(pgId, nextTales)
  }).catch((err) => console.error(`[pg-dualwrite] bard-tales ${campaignId}:`, err.message))
  return sqlLoadBardTales(db, campaignId)
}

// ── Campaign filesystem helpers ───────────────────────────────────────────────

export async function ensureCampaignDirs(campaignId, options = {}) {
  const { create = false } = options
  const resolved = resolveCampaignBase(campaignId)
  const sessionsDir = path.join(resolved.base, 'sessions')
  const importsDir = path.join(resolved.base, 'imports')
  const exportsDir = path.join(resolved.base, 'exports')
  const backupsDir = path.join(resolved.base, 'backups')

  if (create) {
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.mkdir(importsDir, { recursive: true })
    await fs.mkdir(exportsDir, { recursive: true })
    await fs.mkdir(backupsDir, { recursive: true })
    return resolved
  }

  try {
    const stat = await fs.stat(resolved.base)
    if (!stat.isDirectory()) throw new CampaignNotFoundError(resolved.campaignId)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new CampaignNotFoundError(resolved.campaignId)
    throw error
  }

  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.mkdir(importsDir, { recursive: true })
  await fs.mkdir(exportsDir, { recursive: true })
  await fs.mkdir(backupsDir, { recursive: true })
  return resolved
}

export function filesForCampaign(base) {
  return {
    rawSessionsDir: path.join(base, 'sessions'),
    importsDir: path.join(base, 'imports'),
    exportsDir: path.join(base, 'exports'),
    backupsDir: path.join(base, 'backups'),
  }
}

// ── Lexicon helpers ───────────────────────────────────────────────────────────

export function normalizeLexTerm(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function upsertLexiconEntry(lexMap, { term = '', kind = '', creatureType = '', role = '', relation = '', aliases = [], notes = '' } = {}) {
  const normalized = normalizeLexTerm(term)
  if (!normalized) return null

  const existing = lexMap.get(normalized) || {}
  const aliasSet = new Set([...(existing.aliases || []), ...(Array.isArray(aliases) ? aliases : [])].map((x) => String(x || '').trim()).filter(Boolean))

  const next = {
    id: existing.id || crypto.randomUUID(),
    term: String(existing.term || term).trim(),
    kind: String(kind || existing.kind || '').trim(),
    creatureType: String(creatureType || existing.creatureType || '').trim(),
    role: String(role || existing.role || '').trim(),
    relation: String(relation || existing.relation || '').trim(),
    aliases: Array.from(aliasSet),
    notes: String(notes || existing.notes || '').trim(),
    updatedAt: Date.now(),
  }

  lexMap.set(normalized, next)
  return next
}

export function normalizeEntityType(value = '') {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return 'term'
  if (['npc', 'monster', 'quest', 'place', 'event', 'item', 'faction', 'term'].includes(raw)) return raw
  if (['city', 'town', 'region', 'dungeon', 'landmark', 'location'].includes(raw)) return 'place'
  return 'term'
}

export function trackerTypeForEntityType(entityType = '') {
  const t = normalizeEntityType(entityType)
  if (t === 'quest' || t === 'npc' || t === 'place') return t
  return null
}

export function parseQuestDataFromLegacy(legacy = {}) {
  const status = String(legacy?.status || '').trim()
  const objective = String(legacy?.objective || '').trim()
  const reward = String(legacy?.reward || '').trim()
  const latestUpdate = String(legacy?.update || legacy?.latestUpdate || '').trim()
  return { status, objective, reward, latestUpdate }
}

export function makeCanonicalEntity({ campaignId, term = '', entityType = 'term', legacy = {}, source = {} }) {
  return {
    id: String(legacy?.id || '').trim() || crypto.randomUUID(),
    campaignId,
    entityType: normalizeEntityType(entityType || legacy?.entityType || legacy?.kind),
    canonicalTerm: String(term || legacy?.term || legacy?.name || '').trim(),
    notes: String(legacy?.notes || '').trim(),
    data: (legacy?.data && typeof legacy.data === 'object')
      ? legacy.data
      : normalizeEntityType(entityType || legacy?.entityType || legacy?.kind) === 'quest'
        ? parseQuestDataFromLegacy(legacy)
        : {},
    resolution: {
      state: String(legacy?.resolution?.state || '').trim() || 'resolved',
      resolvedToLexiconId: legacy?.resolution?.resolvedToLexiconId || null,
    },
    ownership: {
      canonicalTerm: 'locked',
      entityType: 'locked',
      aliases: 'append_only_review',
      dataStatus: 'mutable',
      dataLatestUpdate: 'mutable',
      listFields: 'append_only_review',
      ...(legacy?.ownership || {}),
    },
    evidence: Array.isArray(legacy?.evidence) ? legacy.evidence : [],
    aliases: Array.isArray(legacy?.aliases) ? legacy.aliases.map((x) => String(x || '').trim()).filter(Boolean) : [],
    createdBy: String(legacy?.createdBy || source.createdBy || 'import').trim(),
    lastUpdatedBy: String(legacy?.lastUpdatedBy || source.lastUpdatedBy || 'import').trim(),
    lastSourceType: String(legacy?.lastSourceType || source.lastSourceType || '').trim(),
    lastSourceId: String(legacy?.lastSourceId || source.lastSourceId || '').trim() || null,
    createdAt: Number(legacy?.createdAt || Date.now()),
    updatedAt: Number(legacy?.updatedAt || Date.now()),
  }
}

export async function ensureCanonicalStores(campaignId, state = null) {
  const { base } = await ensureCampaignDirs(campaignId)
  const now = Date.now()

  const canon = await loadCanonicalStoresSqlPrimary(campaignId, base)
  let entities = Array.isArray(canon.entities) ? canon.entities : []
  let aliases = Array.isArray(canon.aliases) ? canon.aliases : []
  let trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []

  const src = state || {
    lexicon: await loadCampaignDocument(campaignId, base, 'lexicon'),
    quests: await loadCampaignDocument(campaignId, base, 'quests'),
    npcs: await loadCampaignDocument(campaignId, base, 'npcs'),
    places: await loadCampaignDocument(campaignId, base, 'places'),
  }

  const byNorm = new Map()
  for (const e of entities) {
    byNorm.set(normalizeLexTerm(e?.canonicalTerm || ''), e)
  }

  const ensureEntity = ({ term, entityType, legacy, source }) => {
    const norm = normalizeLexTerm(term)
    if (!norm) return null
    const existing = byNorm.get(norm)
    if (existing) return existing
    const created = makeCanonicalEntity({ campaignId, term, entityType, legacy, source })
    byNorm.set(norm, created)
    entities.push(created)
    return created
  }

  // Full-cutover behavior: only run legacy backfill on empty canonical store.
  const lexiconMeta = await loadCampaignDocument(campaignId, base, 'lexiconMeta')
  const needsLegacyBackfill = entities.length === 0 && !lexiconMeta?.skipLegacyBackfill
  if (needsLegacyBackfill) {
    for (const l of (src.lexicon || [])) {
      ensureEntity({ term: l.term, entityType: l.entityType || l.kind, legacy: l, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
    }
    for (const q of (src.quests || [])) {
      const entity = ensureEntity({ term: q.name, entityType: 'quest', legacy: q, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
      if (!entity) continue
      entity.data = { ...parseQuestDataFromLegacy(q), ...(entity.data || {}) }
      entity.updatedAt = now

      const existingRow = trackerRows.find((r) => String(r?.entityId || '') === String(entity.id) && String(r?.trackerType || '') === 'quest')
      const snapshot = {
        status: String(entity?.data?.status || '').trim() || 'Unknown',
        subtitle: String(entity?.data?.objective || entity?.data?.latestUpdate || '').trim(),
      }
      if (existingRow) {
        existingRow.snapshot = snapshot
        existingRow.updatedAt = now
        if (!existingRow.linkMethod) existingRow.linkMethod = 'legacy-backfill'
        if (existingRow.linkConfidence == null) existingRow.linkConfidence = 1
      } else {
        trackerRows.push({
          id: crypto.randomUUID(),
          campaignId,
          trackerType: 'quest',
          entityId: entity.id,
          snapshot,
          linkMethod: 'legacy-backfill',
          linkConfidence: 1,
          updatedAt: now,
        })
      }
    }

    for (const n of (src.npcs || [])) {
      ensureEntity({ term: n.name, entityType: 'npc', legacy: n, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
    }

    for (const p of (src.places || [])) {
      ensureEntity({ term: p.name, entityType: 'place', legacy: p, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
    }
  }

  // Opt-in tracker policy: remove historical NPC/place rows that were auto-backfilled.
  trackerRows = trackerRows.filter((r) => {
    const t = String(r?.trackerType || '')
    const m = String(r?.linkMethod || '')
    if ((t === 'npc' || t === 'place') && m === 'legacy-backfill') return false
    return true
  })

  for (const e of entities) {
    const entityAliases = Array.isArray(e.aliases) ? e.aliases : []
    for (const alias of entityAliases) {
      const normalizedAlias = normalizeLexTerm(alias)
      if (!normalizedAlias) continue
      const exists = aliases.some((a) => normalizeLexTerm(a?.alias || '') === normalizedAlias && String(a?.entityId || '') === String(e.id))
      if (exists) continue
      aliases.push({
        id: crypto.randomUUID(),
        entityType: e.entityType,
        entityId: e.id,
        alias: String(alias).trim(),
        confidence: 1,
        source: 'backfill',
        createdAt: now,
      })
    }
  }

  return await persistCanonicalStoresSqlPrimary(campaignId, base, { entities, aliases, trackerRows })
}

// ── Campaign state ────────────────────────────────────────────────────────────

export async function getCampaignState(campaignId) {
  const { base } = await ensureCampaignDirs(campaignId)

  const [
    storyJournalDoc,
    journalEntries,
    bardsTales,
    canon,
    npcs,
    quests,
    quotes,
    pcs,
    gameSessions,
    approvals,
    lexicon,
    places,
    dmSneakPeek,
    dmNotesDoc,
  ] = await Promise.all([
    loadCampaignDocument(campaignId, base, 'storyJournal'),
    loadJournalEntriesSqlPrimary(campaignId, base),
    loadBardTalesSqlPrimary(campaignId, base),
    loadCanonicalStoresSqlPrimary(campaignId, base),
    loadCampaignDocument(campaignId, base, 'npcs'),
    loadCampaignDocument(campaignId, base, 'quests'),
    loadCampaignDocument(campaignId, base, 'quotes'),
    loadCampaignDocument(campaignId, base, 'pcs'),
    loadCampaignDocument(campaignId, base, 'gameSessions'),
    loadCampaignDocument(campaignId, base, 'approvals'),
    loadCampaignDocument(campaignId, base, 'lexicon'),
    loadCampaignDocument(campaignId, base, 'places'),
    loadCampaignDocument(campaignId, base, 'dmSneakPeek'),
    loadCampaignDocument(campaignId, base, 'dmNotes'),
  ])

  const storyJournalEntries = storyJournalDoc?.entries || []
  const journalById = new Map(journalEntries.map((j) => [String(j?.id || ''), j]))
  const bardsTalesWithState = bardsTales.map((t) => {
    const j = journalById.get(String(t?.journalEntryId || ''))
    const currentHash = j ? sourceHashForText(String(j?.markdown || '')) : null
    const sourceHash = String(t?.sourceHash || '')
    return {
      ...t,
      isStale: !!(currentHash && sourceHash && currentHash !== sourceHash),
    }
  })

  return {
    npcs,
    quests,
    quotes,
    journal: journalEntries,
    storyJournal: storyJournalEntries,
    pcs,
    gameSessions,
    approvals,
    lexicon,
    lexiconEntities: canon.entities,
    entityAliases: canon.aliases,
    trackerRows: canon.trackerRows,
    places,
    bardsTales: bardsTalesWithState,
    dmSneakPeek,
    dmNotes: dmNotesDoc?.text || '',
  }
}

export async function listCampaigns() {
  await fs.mkdir(CAMPAIGNS_DIR, { recursive: true })
  const items = await fs.readdir(CAMPAIGNS_DIR, { withFileTypes: true })
  const out = []
  for (const it of items) {
    if (!it.isDirectory()) continue
    if (/\.pre-sync-\d+$/.test(it.name) || /^backup-clear-\d+$/.test(it.name)) continue

    const metaPath = path.join(CAMPAIGNS_DIR, it.name, 'meta.json')
    const meta = await readJson(metaPath, null)
    if (!meta || !meta.id || !meta.name) continue
    out.push(meta)
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export async function listCampaignSessions(campaignId) {
  const state = await getCampaignState(campaignId)
  return (state.gameSessions || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export async function upsertGameSession(campaignId, { gameSessionId, newGameSessionTitle, newGameSessionNumber, newGameSessionLabel }) {
  const { base } = await ensureCampaignDirs(campaignId)
  const sessions = await loadCampaignDocument(campaignId, base, 'gameSessions')

  if (gameSessionId) {
    const found = sessions.find((s) => s.id === gameSessionId)
    if (!found) throw new Error('gameSessionId not found')
    return found
  }

  const rawNumber = String(newGameSessionNumber ?? newGameSessionTitle ?? '').trim()
  if (!rawNumber) throw new Error('Provide gameSessionId or newGameSessionNumber')
  const numMatch = rawNumber.match(/(\d+)/)
  if (!numMatch) throw new Error('Session number required')
  const title = String(Number(numMatch[1]))
  const label = String(newGameSessionLabel || '').trim()
  const created = {
    id: `${slugify(`session-${title}`)}-${crypto.randomUUID().slice(0, 6)}`,
    title,
    number: Number(title),
    label,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceCount: 0,
  }
  sessions.push(created)
  await persistCampaignDocument(campaignId, base, 'gameSessions', sessions)
  return created
}

export async function addSourceToGameSession(campaignId, gameSessionId, sourceInfo) {
  const { base } = await ensureCampaignDirs(campaignId)
  const sessions = await loadCampaignDocument(campaignId, base, 'gameSessions')
  const idx = sessions.findIndex((s) => s.id === gameSessionId)
  if (idx === -1) return
  sessions[idx].sourceCount = (sessions[idx].sourceCount || 0) + 1
  sessions[idx].updatedAt = Date.now()
  sessions[idx].lastSource = sourceInfo
  await persistCampaignDocument(campaignId, base, 'gameSessions', sessions)
}

// ── Approval workflow ─────────────────────────────────────────────────────────

export async function queueApproval(campaignId, proposal) {
  const { base } = await ensureCampaignDirs(campaignId)
  const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
  approvals.push(proposal)
  await persistCampaignDocument(campaignId, base, 'approvals', approvals)
}

export async function applyApprovedProposal(campaignId, proposalId) {
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)

  const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
  const p = approvals.find((x) => x.id === proposalId)
  if (!p) throw new Error('Proposal not found')
  if (p.status !== 'pending') throw new Error('Proposal already processed')

  const state = await getCampaignState(campaignId)

  const npcMap = new Map(state.npcs.map((n) => [String(n.name || '').toLowerCase(), n]))
  for (const n of p.npcUpdates || []) {
    const incomingName = String(n.name || '').trim()
    const rawKey = incomingName.toLowerCase()
    if (!rawKey) continue

    let matchKey = npcMap.has(rawKey) ? rawKey : null
    if (!matchKey) {
      const incomingNorm = normalizeNpcName(incomingName)
      for (const [k, existing] of npcMap.entries()) {
        const candidateNorms = new Set([
          normalizeNpcName(existing?.name || ''),
          ...((existing?.aliases || []).map((a) => normalizeNpcName(a))),
        ])
        if (candidateNorms.has(incomingNorm)) {
          matchKey = k
          break
        }
      }
    }

    const key = matchKey || rawKey
    const prev = npcMap.get(key) || {}
    const aliases = new Set([...(prev.aliases || [])])
    if (incomingName && incomingName.toLowerCase() !== String(prev.name || '').toLowerCase()) aliases.add(incomingName)

    npcMap.set(key, {
      ...prev,
      ...n,
      name: prev.name || incomingName,
      aliases: Array.from(aliases),
      sourceType: p.sourceType || prev.sourceType || 'unknown',
      sourceId: p.sourceId || prev.sourceId || null,
      updatedAt: Date.now(),
    })
  }

  const questMap = new Map(state.quests.map((q) => [String(q.name || '').toLowerCase(), q]))
  const canon = await ensureCanonicalStores(campaignId, state)
  const entityByTerm = new Map((canon.entities || []).map((e) => [normalizeLexTerm(e?.canonicalTerm || ''), e]))
  const trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []

  for (const q of p.questUpdates || []) {
    const name = String(q.name || '').trim()
    const key = name.toLowerCase()
    if (!key) continue

    const nextQuest = { ...questMap.get(key), ...q, updatedAt: Date.now() }
    questMap.set(key, nextQuest)

    const norm = normalizeLexTerm(name)
    let entity = entityByTerm.get(norm)
    if (!entity) {
      entity = makeCanonicalEntity({
        campaignId,
        term: name,
        entityType: 'quest',
        legacy: {
          aliases: Array.isArray(q.aliases) ? q.aliases : [],
          notes: String(q.notes || '').trim(),
          data: parseQuestDataFromLegacy(q),
        },
        source: {
          createdBy: 'ai',
          lastUpdatedBy: 'ai',
          lastSourceType: String(p.sourceType || '').trim(),
          lastSourceId: String(p.sourceId || '').trim(),
        },
      })
      canon.entities.push(entity)
      entityByTerm.set(norm, entity)
    } else {
      entity.data = {
        ...(entity.data || {}),
        ...parseQuestDataFromLegacy(q),
      }
      entity.notes = String(q.notes || entity.notes || '').trim()
      entity.lastUpdatedBy = 'ai'
      entity.lastSourceType = String(p.sourceType || entity.lastSourceType || '').trim()
      entity.lastSourceId = String(p.sourceId || entity.lastSourceId || '').trim() || entity.lastSourceId || null
      entity.updatedAt = Date.now()
    }

    const row = trackerRows.find((r) => String(r?.trackerType || '') === 'quest' && String(r?.entityId || '') === String(entity.id))
    const snapshot = {
      status: String(entity?.data?.status || nextQuest.status || '').trim() || 'Unknown',
      subtitle: String(entity?.data?.objective || entity?.data?.latestUpdate || nextQuest.update || '').trim(),
    }
    if (row) {
      row.snapshot = snapshot
      row.updatedAt = Date.now()
      row.linkMethod = row.linkMethod || 'exact-term'
      row.linkConfidence = row.linkConfidence == null ? 1 : row.linkConfidence
    } else {
      trackerRows.push({
        id: crypto.randomUUID(),
        campaignId,
        trackerType: 'quest',
        entityId: entity.id,
        snapshot,
        linkMethod: 'exact-term',
        linkConfidence: 1,
        updatedAt: Date.now(),
      })
    }
  }

  const existingQuotes = new Set(state.quotes.map((q) => String(q.text || q)))
  const mergedQuotes = [...state.quotes]
  for (const q of p.quotes || []) {
    const text = typeof q === 'string' ? q : q?.text
    if (!text || existingQuotes.has(text)) continue
    existingQuotes.add(text)
    mergedQuotes.push({ text, createdAt: Date.now(), gameSessionId: p.gameSessionId, sourceId: p.sourceId })
  }

  const journalEntry = {
    id: p.id,
    title: p.gameSessionTitle,
    createdAt: p.createdAt,
    markdown: p.journal || '',
    gameSessionId: p.gameSessionId,
    sourceId: p.sourceId,
    sourceType: p.sourceType || '',
  }

  const sourceType = String(p.sourceType || '')
  const shouldWriteJournal = new Set(['audio', 'transcript']).has(sourceType) && String(p.journal || '').trim().length > 0

  const journalEntries = shouldWriteJournal
    ? ([...(state.journal || []), journalEntry])
    : (state.journal || [])

  const storyEligible = new Set(['audio', 'transcript'])
  const storyJournalEntries = shouldWriteJournal && storyEligible.has(sourceType)
    ? ([...(state.storyJournal || []), journalEntry])
    : (state.storyJournal || [])

  const lexMap = new Map((state.lexicon || []).map((l) => [normalizeLexTerm(l.term || ''), l]))
  for (const l of p.lexiconAdds || []) {
    upsertLexiconEntry(lexMap, {
      term: l.term,
      kind: l.kind,
      aliases: l.aliases,
      notes: l.notes,
    })
  }

  for (const n of Array.from(npcMap.values())) {
    upsertLexiconEntry(lexMap, {
      term: n.name,
      kind: 'npc',
      role: n.role || '',
      relation: n.relation || '',
      aliases: n.aliases || [],
      notes: String(n.notes || n.update || '').trim(),
    })
  }

  for (const q of Array.from(questMap.values())) {
    upsertLexiconEntry(lexMap, {
      term: q.name,
      kind: 'quest',
      aliases: q.aliases || [],
      notes: [q.status, q.update].filter(Boolean).join(' • '),
    })
  }

  const placeMap = new Map((state.places || []).map((pl) => [String(pl.name || '').toLowerCase(), pl]))
  for (const pl of p.placeAdds || []) {
    const key = String(pl.name || '').toLowerCase()
    if (!key) continue
    placeMap.set(key, { ...placeMap.get(key), ...pl, updatedAt: Date.now(), id: placeMap.get(key)?.id || crypto.randomUUID() })
  }

  for (const pl of Array.from(placeMap.values())) {
    upsertLexiconEntry(lexMap, {
      term: pl.name,
      kind: pl.type || 'place',
      aliases: pl.tags || [],
      notes: pl.notes || '',
    })
  }

  await persistCampaignDocument(campaignId, base, 'npcs', Array.from(npcMap.values()))
  await persistCampaignDocument(campaignId, base, 'quests', Array.from(questMap.values()))
  await persistCampaignDocument(campaignId, base, 'quotes', mergedQuotes)
  await persistCampaignDocument(campaignId, base, 'lexicon', Array.from(lexMap.values()))
  await persistCanonicalStoresSqlPrimary(campaignId, base, { entities: canon.entities || [], aliases: canon.aliases || [], trackerRows })
  await persistCampaignDocument(campaignId, base, 'places', Array.from(placeMap.values()))
  await persistJournalEntriesSqlPrimary(campaignId, base, journalEntries)
  await persistCampaignDocument(campaignId, base, 'storyJournal', { entries: storyJournalEntries.slice(-300) })

  if (p.dmNotes && String(p.dmNotes).trim()) {
    const existingDm = await loadCampaignDocument(campaignId, base, 'dmNotes')
    const mergedDm = [existingDm.text || '', `\n\n[Imported ${new Date().toISOString()}]\n${String(p.dmNotes).trim()}`].join('').trim()
    await persistCampaignDocument(campaignId, base, 'dmNotes', { text: mergedDm, updatedAt: Date.now() })
  }

  const rawSessionFile = path.join(f.rawSessionsDir, `${Date.now()}-${p.id}.json`)
  await writeJson(rawSessionFile, p)

  for (const a of approvals) {
    if (a.id === proposalId) {
      a.status = 'approved'
      a.decidedAt = Date.now()
    }
  }
  await persistCampaignDocument(campaignId, base, 'approvals', approvals)
}

export async function rejectProposal(campaignId, proposalId) {
  const { base } = await ensureCampaignDirs(campaignId)
  const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
  for (const a of approvals) {
    if (a.id === proposalId) {
      a.status = 'rejected'
      a.decidedAt = Date.now()
    }
  }
  await persistCampaignDocument(campaignId, base, 'approvals', approvals)
}

// ── Export / backup ───────────────────────────────────────────────────────────

function timestampForFilename(value = Date.now()) {
  return new Date(value).toISOString().replace(/[:.]/g, '-')
}

function escapeSqlString(value = '') {
  return String(value).replace(/'/g, "''")
}

export async function buildCampaignExportPayload(campaignId, options = {}) {
  const { includeArtifactIndex = true } = options
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)
  const meta = await readJson(path.join(base, 'meta.json'), null)
  const state = await getCampaignState(campaignId)

  const payload = {
    version: 1,
    exportedAt: Date.now(),
    campaign: meta,
    persistence: {
      mode: 'sqlite-only',
      databaseFile: 'campaign.sqlite',
    },
    state,
  }

  if (includeArtifactIndex) {
    payload.artifacts = {
      sessions: await fs.readdir(f.rawSessionsDir).catch(() => []),
      imports: await fs.readdir(f.importsDir).catch(() => []),
    }
  }

  return payload
}

export async function writeCampaignExportFile(campaignId, options = {}) {
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)
  const payload = await buildCampaignExportPayload(campaignId, options)
  const stamp = timestampForFilename(payload.exportedAt)
  const fileName = `${stamp}-${campaignId}-export.json`
  const filePath = path.join(f.exportsDir, fileName)
  await writeJson(filePath, payload)
  const stat = await fs.stat(filePath)
  return {
    fileName,
    filePath,
    bytes: stat.size,
    exportedAt: payload.exportedAt,
  }
}

export async function createCampaignSqliteBackup(campaignId) {
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)
  const meta = await readJson(path.join(base, 'meta.json'), null)
  const db = dbForCampaignBase(base)
  ensureSqlSchema(db)

  const createdAt = Date.now()
  const stamp = timestampForFilename(createdAt)
  const fileName = `${stamp}-${campaignId}.sqlite`
  const filePath = path.join(f.backupsDir, fileName)

  try {
    db.exec('PRAGMA wal_checkpoint(FULL)')
  } catch {
    // Database may not be using WAL journaling.
  }

  db.exec(`VACUUM INTO '${escapeSqlString(filePath)}'`)
  const stat = await fs.stat(filePath)

  const manifest = {
    createdAt,
    campaignId,
    campaignName: meta?.name || '',
    databaseFile: 'campaign.sqlite',
    backupFile: fileName,
    bytes: stat.size,
  }
  const manifestFileName = `${stamp}-${campaignId}.json`
  const manifestPath = path.join(f.backupsDir, manifestFileName)
  await writeJson(manifestPath, manifest)

  return {
    fileName,
    filePath,
    manifestFileName,
    manifestPath,
    bytes: stat.size,
    createdAt,
  }
}

// ── Local helper (used only by applyApprovedProposal) ─────────────────────────

function normalizeNpcName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/\b(count|lord|lady|sir|ser|mr|mrs|ms|dr)\b/g, '')
    .replace(/\b(von|van|de|du|the)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
