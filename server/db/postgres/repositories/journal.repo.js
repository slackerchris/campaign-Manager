import crypto from 'node:crypto'
import { db } from '../pool.js'

function toDate(value) {
  if (!value) return new Date()
  if (value instanceof Date) return value
  return new Date(Number(value))
}

export async function loadJournalEntries(campaignId) {
  const rows = await db.selectFrom('journal_entries')
    .where('campaign_id', '=', campaignId)
    .orderBy('created_at', 'asc')
    .selectAll()
    .execute()

  return rows.map(shapeRow)
}

export async function countJournalEntries(campaignId) {
  const result = await db.selectFrom('journal_entries')
    .where('campaign_id', '=', campaignId)
    .select((eb) => eb.fn.count('id').as('count'))
    .executeTakeFirst()
  return Number(result?.count ?? 0)
}

// Full replace (used by pipeline dual-write)
export async function replaceJournalEntries(campaignId, entries = []) {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('journal_entries').where('campaign_id', '=', campaignId).execute()

    const allEntries = Array.isArray(entries) ? entries : []
    if (allEntries.length > 0) {
      await trx.insertInto('journal_entries')
        .values(allEntries.map((e) => {
          const body = String(e?.markdown || e?.body || '')
          return {
            id: String(e?.id || crypto.randomUUID()),
            campaign_id: campaignId,
            session_id: e?.gameSessionId ? String(e.gameSessionId) : null,
            title: String(e?.title || '').trim() || 'Journal Entry',
            body,
            source_hash: sourceHash(body),
            created_at: toDate(e?.createdAt),
            updated_at: toDate(e?.updatedAt || e?.createdAt),
          }
        }))
        .execute()
    }
  })
}

// Upsert a single entry (used by UI edit routes)
export async function upsertJournalEntry(campaignId, entry) {
  const id = String(entry?.id || crypto.randomUUID())
  const body = String(entry?.markdown || entry?.body || '')
  await db.insertInto('journal_entries')
    .values({
      id,
      campaign_id: campaignId,
      session_id: entry?.gameSessionId ? String(entry.gameSessionId) : null,
      title: String(entry?.title || '').trim() || 'Journal Entry',
      body,
      source_hash: sourceHash(body),
      created_at: toDate(entry?.createdAt),
      updated_at: new Date(),
    })
    .onConflict((oc) => oc.column('id').doUpdateSet({
      title: (eb) => eb.ref('excluded.title'),
      body: (eb) => eb.ref('excluded.body'),
      source_hash: (eb) => eb.ref('excluded.source_hash'),
      updated_at: (eb) => eb.ref('excluded.updated_at'),
    }))
    .execute()
  return id
}

export async function deleteJournalEntry(entryId) {
  await db.deleteFrom('journal_entries').where('id', '=', entryId).execute()
}

export async function findJournalEntry(campaignId, entryId) {
  return db.selectFrom('journal_entries')
    .where('campaign_id', '=', campaignId)
    .where('id', '=', entryId)
    .selectAll()
    .executeTakeFirst()
}

function sourceHash(text) {
  if (!text) return ''
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

function shapeRow(r) {
  return {
    id: r.id,
    title: r.title,
    markdown: r.body,
    gameSessionId: r.session_id ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.getTime() : Number(r.updated_at),
  }
}
