import crypto from 'node:crypto'
import { db } from '../pool.js'

const ENTITY_TYPES = new Set(['npc', 'monster', 'place', 'quest', 'item', 'faction', 'term', 'event'])

function normalizeType(value = '') {
  const t = String(value).toLowerCase().trim()
  return ENTITY_TYPES.has(t) ? t : 'term'
}

function toDate(value) {
  if (!value) return new Date()
  if (value instanceof Date) return value
  return new Date(Number(value))
}

// Full replace of entities + aliases (tracker_rows cascade-deleted with entities)
export async function replaceCanonicalStores(campaignId, { entities = [], aliases = [], trackerRows = [] } = {}) {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('lexicon_entities').where('campaign_id', '=', campaignId).execute()

    if (entities.length > 0) {
      await trx.insertInto('lexicon_entities')
        .values(entities.map((e) => ({
          id: String(e?.id || crypto.randomUUID()),
          campaign_id: campaignId,
          entity_type: normalizeType(e?.entityType || e?.entity_type || 'term'),
          canonical_term: String(e?.canonicalTerm || e?.canonical_term || '').trim(),
          notes: String(e?.notes || '').trim(),
          resolution_state: String(e?.resolution?.state || e?.resolution_state || 'resolved').trim() || 'resolved',
          resolved_to_id: e?.resolution?.resolvedToLexiconId || e?.resolved_to_id || null,
          data: e?.data ?? {},
          ownership: e?.ownership ?? {},
          evidence: Array.isArray(e?.evidence) ? e.evidence : [],
          user_id: e?.user_id || null,
          visibility: e?.visibility || 'campaign',
          created_by: String(e?.createdBy || e?.created_by || 'import').trim(),
          last_updated_by: String(e?.lastUpdatedBy || e?.last_updated_by || 'import').trim(),
          last_source_type: String(e?.lastSourceType || e?.last_source_type || '').trim(),
          last_source_id: e?.lastSourceId || e?.last_source_id || null,
          created_at: toDate(e?.createdAt || e?.created_at),
          updated_at: toDate(e?.updatedAt || e?.updated_at),
        })))
        .execute()
    }

    if (aliases.length > 0) {
      const valid = aliases.filter((a) => String(a?.alias || '').trim() && String(a?.entityId || a?.entity_id || '').trim())
      if (valid.length > 0) {
        await trx.insertInto('entity_aliases')
          .values(valid.map((a) => ({
            id: String(a?.id || crypto.randomUUID()),
            entity_id: String(a?.entityId || a?.entity_id),
            alias: String(a.alias).trim(),
            confidence: Number(a?.confidence ?? 1),
            source: String(a?.source || 'import').trim(),
            created_at: toDate(a?.createdAt || a?.created_at),
          })))
          .onConflict((oc) => oc.columns(['entity_id', 'alias']).doUpdateSet({
            confidence: (eb) => eb.ref('excluded.confidence'),
            source: (eb) => eb.ref('excluded.source'),
          }))
          .execute()
      }
    }

    if (trackerRows.length > 0) {
      const valid = trackerRows.filter((r) => String(r?.entityId || r?.entity_id || '').trim())
      if (valid.length > 0) {
        await trx.insertInto('tracker_rows')
          .values(valid.map((r) => ({
            id: String(r?.id || crypto.randomUUID()),
            campaign_id: campaignId,
            tracker_type: String(r?.trackerType || r?.tracker_type || '').trim(),
            entity_id: String(r?.entityId || r?.entity_id),
            snapshot: r?.snapshot ?? {},
            link_method: String(r?.linkMethod || r?.link_method || 'manual').trim(),
            link_confidence: Number(r?.linkConfidence ?? r?.link_confidence ?? 1),
            updated_at: toDate(r?.updatedAt || r?.updated_at),
          })))
          .onConflict((oc) => oc.column('id').doUpdateSet({
            tracker_type: (eb) => eb.ref('excluded.tracker_type'),
            entity_id: (eb) => eb.ref('excluded.entity_id'),
            snapshot: (eb) => eb.ref('excluded.snapshot'),
            link_method: (eb) => eb.ref('excluded.link_method'),
            link_confidence: (eb) => eb.ref('excluded.link_confidence'),
            updated_at: (eb) => eb.ref('excluded.updated_at'),
          }))
          .execute()
      }
    }
  })
}

export async function loadEntities(campaignId) {
  const entityRows = await db.selectFrom('lexicon_entities')
    .where('campaign_id', '=', campaignId)
    .orderBy('created_at', 'asc')
    .orderBy('canonical_term', 'asc')
    .selectAll()
    .execute()

  const aliasRows = await db.selectFrom('entity_aliases as ea')
    .innerJoin('lexicon_entities as le', 'le.id', 'ea.entity_id')
    .where('le.campaign_id', '=', campaignId)
    .orderBy('ea.created_at', 'asc')
    .select(['ea.id', 'ea.entity_id', 'ea.alias', 'ea.confidence', 'ea.source', 'ea.created_at', 'le.entity_type'])
    .execute()

  const aliasesByEntityId = new Map()
  const aliasObjects = aliasRows.map((a) => {
    if (!aliasesByEntityId.has(a.entity_id)) aliasesByEntityId.set(a.entity_id, [])
    aliasesByEntityId.get(a.entity_id).push(a.alias)
    return {
      id: a.id,
      entityType: a.entity_type,
      entityId: a.entity_id,
      alias: a.alias,
      confidence: Number(a.confidence),
      source: a.source,
      createdAt: a.created_at instanceof Date ? a.created_at.getTime() : Number(a.created_at),
    }
  })

  const entities = entityRows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    entityType: row.entity_type,
    canonicalTerm: row.canonical_term,
    notes: row.notes,
    data: row.data ?? {},
    resolution: {
      state: row.resolution_state,
      resolvedToLexiconId: row.resolved_to_id ?? null,
    },
    ownership: row.ownership ?? {},
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    aliases: aliasesByEntityId.get(row.id) ?? [],
    createdBy: row.created_by,
    lastUpdatedBy: row.last_updated_by,
    lastSourceType: row.last_source_type,
    lastSourceId: row.last_source_id,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Number(row.updated_at),
  }))

  return { entities, aliases: aliasObjects }
}

export async function upsertEntity(campaignId, entity) {
  const id = String(entity?.id || crypto.randomUUID())
  await db.insertInto('lexicon_entities')
    .values({
      id,
      campaign_id: campaignId,
      entity_type: normalizeType(entity?.entityType || entity?.entity_type || 'term'),
      canonical_term: String(entity?.canonicalTerm || entity?.canonical_term || '').trim(),
      notes: String(entity?.notes || '').trim(),
      resolution_state: String(entity?.resolution?.state || entity?.resolution_state || 'resolved'),
      resolved_to_id: entity?.resolution?.resolvedToLexiconId || entity?.resolved_to_id || null,
      data: entity?.data ?? {},
      ownership: entity?.ownership ?? {},
      evidence: Array.isArray(entity?.evidence) ? entity.evidence : [],
      user_id: entity?.user_id || null,
      visibility: entity?.visibility || 'campaign',
      created_by: String(entity?.createdBy || entity?.created_by || 'manual').trim(),
      last_updated_by: String(entity?.lastUpdatedBy || entity?.last_updated_by || 'manual').trim(),
      last_source_type: String(entity?.lastSourceType || entity?.last_source_type || '').trim(),
      last_source_id: entity?.lastSourceId || entity?.last_source_id || null,
      created_at: toDate(entity?.createdAt || entity?.created_at),
      updated_at: new Date(),
    })
    .onConflict((oc) => oc.column('id').doUpdateSet({
      entity_type: (eb) => eb.ref('excluded.entity_type'),
      canonical_term: (eb) => eb.ref('excluded.canonical_term'),
      notes: (eb) => eb.ref('excluded.notes'),
      resolution_state: (eb) => eb.ref('excluded.resolution_state'),
      resolved_to_id: (eb) => eb.ref('excluded.resolved_to_id'),
      data: (eb) => eb.ref('excluded.data'),
      ownership: (eb) => eb.ref('excluded.ownership'),
      evidence: (eb) => eb.ref('excluded.evidence'),
      last_updated_by: (eb) => eb.ref('excluded.last_updated_by'),
      last_source_type: (eb) => eb.ref('excluded.last_source_type'),
      last_source_id: (eb) => eb.ref('excluded.last_source_id'),
      updated_at: (eb) => eb.ref('excluded.updated_at'),
    }))
    .execute()
  return id
}

export async function findEntity(campaignId, entityId) {
  return db.selectFrom('lexicon_entities')
    .where('campaign_id', '=', campaignId)
    .where('id', '=', entityId)
    .selectAll()
    .executeTakeFirst()
}

export async function deleteEntity(entityId) {
  await db.deleteFrom('lexicon_entities').where('id', '=', entityId).execute()
}

export async function upsertAlias(entityId, alias, confidence = 1, source = 'manual') {
  await db.insertInto('entity_aliases')
    .values({ id: crypto.randomUUID(), entity_id: entityId, alias, confidence, source })
    .onConflict((oc) => oc.columns(['entity_id', 'alias']).doUpdateSet({ confidence, source }))
    .execute()
}

export async function deleteAlias(entityId, alias) {
  await db.deleteFrom('entity_aliases')
    .where('entity_id', '=', entityId)
    .where('alias', '=', alias)
    .execute()
}
