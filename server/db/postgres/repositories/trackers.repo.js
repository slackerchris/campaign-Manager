import { db } from '../pool.js'

export async function loadTrackers(campaignId) {
  const rows = await db.selectFrom('tracker_rows')
    .where('campaign_id', '=', campaignId)
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'asc')
    .selectAll()
    .execute()

  return rows.map(shapeRow)
}

export async function loadTrackersByType(campaignId, trackerType) {
  const rows = await db.selectFrom('tracker_rows as tr')
    .innerJoin('lexicon_entities as le', 'le.id', 'tr.entity_id')
    .where('tr.campaign_id', '=', campaignId)
    .where('tr.tracker_type', '=', trackerType)
    .orderBy('tr.updated_at', 'desc')
    .select([
      'tr.id', 'tr.campaign_id', 'tr.tracker_type', 'tr.entity_id',
      'tr.snapshot', 'tr.link_method', 'tr.link_confidence', 'tr.updated_at',
      'le.id as le_id', 'le.entity_type', 'le.canonical_term', 'le.notes',
      'le.resolution_state', 'le.resolved_to_id', 'le.data', 'le.ownership',
      'le.evidence', 'le.created_at as le_created_at', 'le.updated_at as le_updated_at',
    ])
    .execute()

  return rows.map((r) => ({
    ...shapeRow(r),
    entity: {
      id: r.le_id,
      entityType: r.entity_type,
      canonicalTerm: r.canonical_term,
      notes: r.notes,
      data: r.data ?? {},
      resolution: { state: r.resolution_state, resolvedToLexiconId: r.resolved_to_id ?? null },
      ownership: r.ownership ?? {},
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
      createdAt: r.le_created_at instanceof Date ? r.le_created_at.getTime() : Number(r.le_created_at),
      updatedAt: r.le_updated_at instanceof Date ? r.le_updated_at.getTime() : Number(r.le_updated_at),
    },
  }))
}

function shapeRow(r) {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    trackerType: r.tracker_type,
    entityId: r.entity_id,
    snapshot: r.snapshot ?? {},
    linkMethod: r.link_method,
    linkConfidence: Number(r.link_confidence),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.getTime() : Number(r.updated_at),
  }
}
