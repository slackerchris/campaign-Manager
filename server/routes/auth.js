import express from 'express'
import crypto from 'node:crypto'
import { db as pgDb } from '../db/postgres/pool.js'
import * as campaignsRepo from '../db/postgres/repositories/campaigns.repo.js'
import * as membersRepo from '../db/postgres/repositories/members.repo.js'
import * as campaignInvitesRepo from '../db/postgres/repositories/campaign-invites.repo.js'

export const authRouter = express.Router({ mergeParams: true })

// ── DM: create general invite link ────────────────────────────────────────────

authRouter.post('/invites', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'dm') {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can create invites' })
    }
    const { campaignId: slug } = req.params
    const { role = 'player' } = req.body

    const campaign = await campaignsRepo.findCampaignBySlug(slug)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (campaign.owner_user_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can create invites' })
    }

    const token = crypto.randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
    const invite = await campaignInvitesRepo.createCampaignInvite({
      token,
      campaignId: campaign.id,
      targetUserId: null,
      createdByUserId: req.user.id,
      role,
      dmDisplayName: req.user.displayName || 'DM',
      expiresAt,
    })

    res.json({ ok: true, invite: { token: invite.token, role: invite.role, expiresAt: invite.expires_at.getTime() } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

// ── DM: send a directed invite to a specific server user ─────────────────────

authRouter.post('/direct-invite', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'dm') {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can send invites' })
    }
    const { campaignId: slug } = req.params
    const { targetServerUserId } = req.body
    if (!targetServerUserId) return res.status(400).json({ ok: false, error: 'targetServerUserId required' })

    const campaign = await campaignsRepo.findCampaignBySlug(slug)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (campaign.owner_user_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can send invites' })
    }

    const existing = await membersRepo.findMember(campaign.id, targetServerUserId)
    if (existing) return res.status(409).json({ ok: false, error: 'User is already in this campaign' })

    const pending = await campaignInvitesRepo.findPendingDirectedInvite(campaign.id, targetServerUserId)
    if (pending) return res.status(409).json({ ok: false, error: 'A pending invite already exists for this user' })

    const token = crypto.randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    const invite = await campaignInvitesRepo.createCampaignInvite({
      token,
      campaignId: campaign.id,
      targetUserId: targetServerUserId,
      createdByUserId: req.user.id,
      role: 'player',
      dmDisplayName: req.user.displayName || 'DM',
      expiresAt,
    })

    res.json({ ok: true, invite: { token: invite.token, expiresAt: invite.expires_at.getTime() } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

// ── Player: accept a directed invite (requires server account) ────────────────

authRouter.post('/accept-direct-invite', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })

    const { campaignId: slug } = req.params
    const { inviteToken, displayName } = req.body
    if (!inviteToken) return res.status(400).json({ ok: false, error: 'inviteToken required' })

    const campaign = await campaignsRepo.findCampaignBySlug(slug)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })

    await pgDb.transaction().execute(async (trx) => {
      const invite = await trx
        .selectFrom('campaign_invites')
        .selectAll()
        .where('token', '=', inviteToken)
        .forUpdate()
        .executeTakeFirst()

      if (!invite) throw Object.assign(new Error('INVITE_INVALID'), { statusCode: 400 })
      if (invite.consumed_at) throw Object.assign(new Error('INVITE_CONSUMED'), { statusCode: 400 })
      if (invite.expires_at < new Date()) throw Object.assign(new Error('INVITE_EXPIRED'), { statusCode: 400 })
      if (invite.target_user_id && invite.target_user_id !== req.user.id) {
        throw Object.assign(new Error('INVITE_NOT_FOR_YOU'), { statusCode: 403 })
      }

      const finalDisplayName = String(displayName || req.user.displayName || '').trim() || 'Player'

      await trx
        .insertInto('campaign_members')
        .values({ campaign_id: campaign.id, user_id: req.user.id, display_name: finalDisplayName, role: invite.role, joined_at: new Date() })
        .onConflict((oc) => oc.columns(['campaign_id', 'user_id']).doNothing())
        .execute()

      await trx
        .updateTable('campaign_invites')
        .set({ consumed_at: new Date(), consumed_by_user_id: req.user.id })
        .where('token', '=', inviteToken)
        .execute()
    })

    res.json({ ok: true, campaignId: slug })
  } catch (err) {
    const messages = { INVITE_INVALID: 'Invalid invite', INVITE_CONSUMED: 'Invite already used', INVITE_EXPIRED: 'Invite expired', INVITE_NOT_FOR_YOU: 'This invite is for a different user' }
    const msg = messages[err.message]
    if (msg) return res.status(err.statusCode || 400).json({ ok: false, error: msg })
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

// ── Player: join with a general invite token (requires server account) ─────────

authRouter.post('/join', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required to join a campaign' })

    const { campaignId: slug } = req.params
    const { inviteToken, displayName } = req.body
    if (!inviteToken) return res.status(400).json({ ok: false, error: 'inviteToken required' })

    const campaign = await campaignsRepo.findCampaignBySlug(slug)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })

    await pgDb.transaction().execute(async (trx) => {
      const invite = await trx
        .selectFrom('campaign_invites')
        .selectAll()
        .where('token', '=', inviteToken)
        .where('campaign_id', '=', campaign.id)
        .forUpdate()
        .executeTakeFirst()

      if (!invite) throw Object.assign(new Error('INVITE_INVALID'), { statusCode: 400 })
      if (invite.consumed_at) throw Object.assign(new Error('INVITE_CONSUMED'), { statusCode: 400 })
      if (invite.expires_at < new Date()) throw Object.assign(new Error('INVITE_EXPIRED'), { statusCode: 400 })

      const finalDisplayName = String(displayName || req.user.displayName || '').trim() || 'Player'

      await trx
        .insertInto('campaign_members')
        .values({ campaign_id: campaign.id, user_id: req.user.id, display_name: finalDisplayName, role: invite.role, joined_at: new Date() })
        .onConflict((oc) => oc.columns(['campaign_id', 'user_id']).doNothing())
        .execute()

      await trx
        .updateTable('campaign_invites')
        .set({ consumed_at: new Date(), consumed_by_user_id: req.user.id })
        .where('token', '=', inviteToken)
        .execute()
    })

    res.json({ ok: true, campaignId: slug })
  } catch (err) {
    const messages = { INVITE_INVALID: 'Invalid invite', INVITE_CONSUMED: 'Invite already consumed', INVITE_EXPIRED: 'Invite expired' }
    const msg = messages[err.message]
    if (msg) return res.status(err.statusCode || 400).json({ ok: false, error: msg })
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})
