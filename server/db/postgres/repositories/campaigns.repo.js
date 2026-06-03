import { db } from '../pool.js'

export async function findCampaignBySlug(slug) {
  return db.selectFrom('campaigns').selectAll().where('slug', '=', slug).executeTakeFirst()
}

export async function findCampaignById(id) {
  return db.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function listAllCampaigns() {
  return db.selectFrom('campaigns').selectAll().orderBy('created_at', 'desc').execute()
}

export async function createCampaign({ slug, name, ownerUserId, ownerDisplayName }) {
  const now = new Date()
  return db
    .insertInto('campaigns')
    .values({ slug, name, owner_user_id: ownerUserId, owner_display_name: ownerDisplayName, created_at: now, updated_at: now })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function deleteCampaign(id) {
  return db.deleteFrom('campaigns').where('id', '=', id).executeTakeFirst()
}

export async function updateCampaign(id, fields) {
  return db
    .updateTable('campaigns')
    .set({ ...fields, updated_at: new Date() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
}
