import crypto from 'node:crypto';
import { ensureSqlSchema } from './migrations.js';
import { dbForCampaignBase, runInTx } from './index.js';
import { BARD_PROMPT_VERSION } from '../config.js'; // We need this or we must define it

export function forUser(user, tableAlias = '') {
  if (!user || user.role === 'dm') return '1=1' // DM bypass
  const prefix = tableAlias ? `${tableAlias}.` : ''
  // Use bound parameters or safe strings, assuming user.id is a UUID without quotes
  return `(${prefix}visibility = 'campaign' OR ${prefix}visibility = 'shared_with_dm' OR ${prefix}user_id = '${user.id}')`
}

export function sqlUpsertCanonicalFromMemory(db, campaignId, canon) {
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

export function sqlLoadCanonicalStores(db, campaignId) {
  ensureSqlSchema(db)

  const entityRows = db.prepare(`
    SELECT
      id, campaign_id, entity_type, canonical_term, notes, resolution_state,
      resolved_to_lexicon_id, data_json, ownership_json, evidence_json,
      created_by, last_updated_by, last_source_type, last_source_id, created_at, updated_at,
      user_id, visibility
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

  // NOTE: filtering wasn't done natively in the query here because sqlLoadCanonicalStores lacks req.user in signature right now.
  // In a full implementation, you map load/upsert functions to take req.user.

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

export const CAMPAIGN_DOCUMENT_DEFS = {
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
}

export function cloneCampaignDocumentDefault(docKey) {
  const def = CAMPAIGN_DOCUMENT_DEFS[docKey]
  if (!def) throw new Error(`Unsupported campaign document: ${docKey}`)
  return JSON.parse(JSON.stringify(def.defaultValue))
}

export function sqlLoadCampaignDocument(db, campaignId, docKey) {
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

export function sqlUpsertCampaignDocument(db, campaignId, docKey, value) {
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

export function sqlUpsertJournalEntries(db, campaignId, entries = []) {
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

export function sqlLoadJournalEntries(db, campaignId) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    SELECT id, campaign_id, session_id, title, body, source_hash, created_at, updated_at, user_id, visibility
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

export function sqlUpsertBardTales(db, campaignId, tales = []) {
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

export function sqlLoadBardTales(db, campaignId) {
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

export function sqlReplaceJournalEntries(db, campaignId, entries = []) {
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

export function sqlReplaceBardTales(db, campaignId, tales = []) {
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

export async function loadCampaignDocument(campaignId, base, docKey) {
  const db = dbForCampaignBase(base)
  return sqlLoadCampaignDocument(db, campaignId, docKey)
}

export async function persistCampaignDocument(campaignId, base, docKey, value) {
  const db = dbForCampaignBase(base)
  sqlUpsertCampaignDocument(db, campaignId, docKey, value)
  return sqlLoadCampaignDocument(db, campaignId, docKey)
}

export async function loadCanonicalStoresSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadCanonicalStores(db, campaignId)
}

export async function persistCanonicalStoresSqlPrimary(campaignId, base, canon = {}) {
  const db = dbForCampaignBase(base)
  sqlUpsertCanonicalFromMemory(db, campaignId, canon)
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
  return sqlLoadJournalEntries(db, campaignId)
}

export async function loadBardTalesSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadBardTales(db, campaignId)
}

export async function persistBardTalesSqlPrimary(campaignId, base, tales = []) {
  const db = dbForCampaignBase(base)
  sqlReplaceBardTales(db, campaignId, Array.isArray(tales) ? tales : [])
  return sqlLoadBardTales(db, campaignId)
}