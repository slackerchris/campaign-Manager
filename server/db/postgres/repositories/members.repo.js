import { db } from '../pool.js'

export async function findMember(campaignId, userId) {
  return db
    .selectFrom('campaign_members')
    .selectAll()
    .where('campaign_id', '=', campaignId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
}

export async function addMember({ campaignId, userId, displayName, role }) {
  return db
    .insertInto('campaign_members')
    .values({ campaign_id: campaignId, user_id: userId, display_name: displayName, role, joined_at: new Date() })
    .onConflict((oc) => oc.columns(['campaign_id', 'user_id']).doNothing())
    .returningAll()
    .executeTakeFirst()
}

export async function listMembers(campaignId) {
  return db
    .selectFrom('campaign_members as cm')
    .innerJoin('users as u', 'u.id', 'cm.user_id')
    .select(['cm.campaign_id', 'cm.user_id', 'cm.display_name', 'cm.role', 'cm.joined_at', 'u.username'])
    .where('cm.campaign_id', '=', campaignId)
    .orderBy('cm.joined_at', 'asc')
    .execute()
}

// Returns all campaigns a user is a member of, with campaign details
export async function listCampaignsForUser(userId) {
  return db
    .selectFrom('campaign_members as cm')
    .innerJoin('campaigns as c', 'c.id', 'cm.campaign_id')
    .select(['c.id', 'c.slug', 'c.name', 'c.owner_user_id', 'c.owner_display_name', 'c.created_at', 'cm.role', 'cm.display_name'])
    .where('cm.user_id', '=', userId)
    .orderBy('c.created_at', 'desc')
    .execute()
}
