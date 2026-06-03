import crypto from 'node:crypto'
import { db } from '../pool.js'
import { BARD_PROMPT_VERSION } from '../../../config.js'

function toDate(value) {
  if (!value) return new Date()
  if (value instanceof Date) return value
  return new Date(Number(value))
}

export async function loadBardTales(campaignId) {
  const rows = await db.selectFrom('bard_tales as bt')
    .leftJoin('journal_entries as je', 'je.id', 'bt.journal_entry_id')
    .where('bt.campaign_id', '=', campaignId)
    .orderBy('bt.created_at', 'desc')
    .select([
      'bt.id', 'bt.campaign_id', 'bt.journal_entry_id', 'bt.title',
      'bt.bard_name', 'bt.persona_id', 'bt.faithfulness', 'bt.prompt_version',
      'bt.source_hash', 'bt.source_length', 'bt.text', 'bt.created_at',
      'je.title as journal_title', 'je.body as journal_body', 'je.source_hash as journal_hash',
    ])
    .execute()

  return rows.map(shapeRow)
}

// Full replace (used by pipeline dual-write)
export async function replaceBardTales(campaignId, tales = []) {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('bard_tales').where('campaign_id', '=', campaignId).execute()

    const all = Array.isArray(tales) ? tales : []
    if (all.length > 0) {
      await trx.insertInto('bard_tales')
        .values(all.map((t) => ({
          id: String(t?.id || crypto.randomUUID()),
          campaign_id: campaignId,
          journal_entry_id: t?.journalEntryId ? String(t.journalEntryId) : null,
          title: String(t?.title || t?.journalEntryTitle || 'The Tale').trim(),
          bard_name: String(t?.bardName || '').trim() || null,
          persona_id: String(t?.personaId || '').trim() || null,
          faithfulness: String(t?.faithfulness || '').trim() || null,
          prompt_version: String(t?.promptVersion || '').trim() || null,
          source_hash: String(t?.sourceHash || '').trim() || null,
          source_length: Number(t?.sourceLength || 0),
          text: String(t?.text || t?.tale || ''),
          created_at: toDate(t?.createdAt),
        })))
        .execute()
    }
  })
}

// Upsert a single tale (used by UI save routes)
export async function upsertBardTale(campaignId, tale) {
  const id = String(tale?.id || crypto.randomUUID())
  await db.insertInto('bard_tales')
    .values({
      id,
      campaign_id: campaignId,
      journal_entry_id: tale?.journalEntryId ? String(tale.journalEntryId) : null,
      title: String(tale?.title || tale?.journalEntryTitle || 'The Tale').trim(),
      bard_name: String(tale?.bardName || '').trim() || null,
      persona_id: String(tale?.personaId || '').trim() || null,
      faithfulness: String(tale?.faithfulness || '').trim() || null,
      prompt_version: String(tale?.promptVersion || '').trim() || null,
      source_hash: String(tale?.sourceHash || '').trim() || null,
      source_length: Number(tale?.sourceLength || 0),
      text: String(tale?.text || tale?.tale || ''),
      created_at: toDate(tale?.createdAt),
    })
    .onConflict((oc) => oc.column('id').doUpdateSet({
      title: (eb) => eb.ref('excluded.title'),
      bard_name: (eb) => eb.ref('excluded.bard_name'),
      persona_id: (eb) => eb.ref('excluded.persona_id'),
      faithfulness: (eb) => eb.ref('excluded.faithfulness'),
      prompt_version: (eb) => eb.ref('excluded.prompt_version'),
      source_hash: (eb) => eb.ref('excluded.source_hash'),
      source_length: (eb) => eb.ref('excluded.source_length'),
      text: (eb) => eb.ref('excluded.text'),
    }))
    .execute()
  return id
}

export async function deleteBardTale(taleId) {
  await db.deleteFrom('bard_tales').where('id', '=', taleId).execute()
}

function shapeRow(r) {
  return {
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
    isStale: !!(r.journal_hash && r.source_hash && r.journal_hash !== r.source_hash),
    createdAt: r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at),
    updatedAt: r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at),
  }
}
