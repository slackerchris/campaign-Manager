import { db } from '../pool.js'

const DEFAULTS = {
  npcs: [],
  quests: [],
  quotes: [],
  storyJournal: { entries: [] },
  pcs: [],
  gameSessions: [],
  approvals: [],
  lexicon: [],
  places: [],
  dmNotes: { text: '' },
  dmSneakPeek: [],
}

function defaultFor(docKey) {
  const def = DEFAULTS[docKey]
  if (def === undefined) return null
  return JSON.parse(JSON.stringify(def))
}

export async function loadDocument(campaignId, docKey) {
  const row = await db.selectFrom('campaign_documents')
    .where('campaign_id', '=', campaignId)
    .where('doc_key', '=', docKey)
    .select('content')
    .executeTakeFirst()

  return row ? row.content : defaultFor(docKey)
}

// Returns { docKey: content, ... } for all documents belonging to the campaign
export async function loadAllDocuments(campaignId) {
  const rows = await db.selectFrom('campaign_documents')
    .where('campaign_id', '=', campaignId)
    .select(['doc_key', 'content'])
    .execute()

  const map = Object.fromEntries(rows.map((r) => [r.doc_key, r.content]))
  // Fill in missing defaults so callers never see undefined
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (!(key in map)) map[key] = JSON.parse(JSON.stringify(def))
  }
  return map
}

export async function upsertDocument(campaignId, docKey, content) {
  await db.insertInto('campaign_documents')
    .values({ campaign_id: campaignId, doc_key: docKey, content, updated_at: new Date() })
    .onConflict((oc) => oc.columns(['campaign_id', 'doc_key']).doUpdateSet({
      content: (eb) => eb.ref('excluded.content'),
      updated_at: (eb) => eb.ref('excluded.updated_at'),
    }))
    .execute()
}

export async function countArrayDocument(campaignId, docKey) {
  const row = await db.selectFrom('campaign_documents')
    .where('campaign_id', '=', campaignId)
    .where('doc_key', '=', docKey)
    .select('content')
    .executeTakeFirst()

  if (!row) return 0
  return Array.isArray(row.content) ? row.content.length : 0
}
