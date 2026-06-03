import { db } from '../pool.js'

export async function createCampaignInvite({ token, campaignId, targetUserId, createdByUserId, role, dmDisplayName, expiresAt }) {
  return db
    .insertInto('campaign_invites')
    .values({
      token,
      campaign_id: campaignId,
      target_user_id: targetUserId || null,
      created_by_user_id: createdByUserId,
      role: role || 'player',
      dm_display_name: dmDisplayName || null,
      created_at: new Date(),
      expires_at: expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function findCampaignInvite(token) {
  return db.selectFrom('campaign_invites').selectAll().where('token', '=', token).executeTakeFirst()
}

export async function consumeCampaignInvite({ token, consumedByUserId }) {
  return db
    .updateTable('campaign_invites')
    .set({ consumed_at: new Date(), consumed_by_user_id: consumedByUserId })
    .where('token', '=', token)
    .returningAll()
    .executeTakeFirst()
}

// Pending directed invites targeting a specific server user
export async function listPendingInvitesForUser(userId) {
  return db
    .selectFrom('campaign_invites as ci')
    .innerJoin('campaigns as c', 'c.id', 'ci.campaign_id')
    .select([
      'ci.token', 'ci.role', 'ci.dm_display_name', 'ci.expires_at',
      'c.id as campaign_id', 'c.slug as campaign_slug', 'c.name as campaign_name',
      'c.owner_display_name',
    ])
    .where('ci.target_user_id', '=', userId)
    .where('ci.consumed_at', 'is', null)
    .where('ci.expires_at', '>', new Date())
    .orderBy('ci.created_at', 'desc')
    .execute()
}

export async function findPendingDirectedInvite(campaignId, targetUserId) {
  return db
    .selectFrom('campaign_invites')
    .selectAll()
    .where('campaign_id', '=', campaignId)
    .where('target_user_id', '=', targetUserId)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst()
}
