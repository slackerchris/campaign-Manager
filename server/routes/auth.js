import express from 'express'
import crypto from 'node:crypto'
import { dbForCampaignBase, runInTx } from '../db/index.js'
import { resolveCampaignBase } from '../utils.js'
import { APP_TOKEN } from '../config.js'

export const authRouter = express.Router({ mergeParams: true })

authRouter.post('/bootstrap', async (req, res) => {
  try {
    const { campaignId } = req.params
    const { token, displayName = 'Dungeon Master' } = req.body

    // 1. Verify Bootstrap Token
    if (!APP_TOKEN) {
      return res.status(400).json({ ok: false, error: 'No APP_TOKEN configured on server for bootstrap' })
    }
    
    let valid = false
    try {
      const tokenBuf = Buffer.from(token || '')
      const expectedBuf = Buffer.from(APP_TOKEN)
      valid = tokenBuf.length === expectedBuf.length && crypto.timingSafeEqual(tokenBuf, expectedBuf)
    } catch { valid = false }

    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Invalid bootstrap token' })
    }

    const { base } = resolveCampaignBase(campaignId)
    const db = dbForCampaignBase(base)

    // 2. Check if a DM already exists
    const existingDm = db.prepare('SELECT id FROM users WHERE role = ?').get('dm')
    if (existingDm && !req.body.forceRecovery) {
      // If we want to allow recovery, we can bypass this with forceRecovery flag
      return res.status(400).json({ ok: false, error: 'A DM account already exists for this campaign' })
    }

    // 3. Create DM User
    const userId = crypto.randomUUID()
    const now = Date.now()
    
    runInTx(db, () => {
      // Only insert if it doesn't exist to prevent duplicates on recovery
      db.prepare(`
        INSERT INTO users (id, display_name, role, created_at, last_seen_at) 
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, displayName.trim(), 'dm', now, now)
    })

    // 4. Issue session token
    const sessionToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = now + (1000 * 60 * 60 * 24 * 30) // 30 days
    db.prepare(`
      INSERT INTO sessions_auth (token, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionToken, userId, now, expiresAt)

    res.json({ ok: true, session: { token: sessionToken, userId, role: 'dm', expiresAt } })
  } catch (err) {
    if (err.name === 'CampaignNotFoundError' || err.name === 'InvalidCampaignIdError') {
      return res.status(404).json({ ok: false, error: 'Campaign not found' })
    }
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

authRouter.post('/invites', async (req, res) => {
  // TODO: Add proper auth middleware check here once implemented in Phase 2
  // For now, we will assume req.user is populated by a middleware we'll write next
  try {
    if (!req.user || req.user.role !== 'dm') {
      return res.status(403).json({ ok: false, error: 'Only DM can create invites' })
    }
    const { campaignId } = req.params
    const { role = 'player' } = req.body

    const { base } = resolveCampaignBase(campaignId)
    const db = dbForCampaignBase(base)
    
    const token = crypto.randomBytes(16).toString('hex')
    const now = Date.now()
    const expiresAt = now + (1000 * 60 * 60 * 24 * 7) // 7 days default
    
    db.prepare(`
      INSERT INTO invites (token, role, created_by, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, role, req.user.id, expiresAt)
    
    res.json({ ok: true, invite: { token, role, expiresAt } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

authRouter.post('/join', async (req, res) => {
  try {
    const { campaignId } = req.params
    const { inviteToken, displayName } = req.body

    if (!inviteToken || !displayName?.trim()) {
      return res.status(400).json({ ok: false, error: 'Invite token and display name are required' })
    }

    const { base } = resolveCampaignBase(campaignId)
    const db = dbForCampaignBase(base)
    const now = Date.now()

    let sessionToken = null;
    let userId = null;
    let role = null;
    let expiresAt = null;

    runInTx(db, () => {
      // 1. Verify invite
      const invite = db.prepare('SELECT token, role, expires_at, consumed_at FROM invites WHERE token = ?').get(inviteToken)
      if (!invite) throw new Error('INVITE_INVALID')
      if (invite.consumed_at) throw new Error('INVITE_CONSUMED')
      if (invite.expires_at < now) throw new Error('INVITE_EXPIRED')

      // 2. Create User
      userId = crypto.randomUUID()
      role = invite.role
      db.prepare(`
        INSERT INTO users (id, display_name, role, created_at, last_seen_at) 
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, displayName.trim(), role, now, now)

      // 3. Consume invite
      db.prepare(`
        UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE token = ?
      `).run(now, userId, inviteToken)

      // 4. Issue session token (30 days)
      sessionToken = crypto.randomBytes(32).toString('hex')
      expiresAt = now + (1000 * 60 * 60 * 24 * 30)
      db.prepare(`
        INSERT INTO sessions_auth (token, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(sessionToken, userId, now, expiresAt)
    })

    res.json({ ok: true, session: { token: sessionToken, userId, role, expiresAt } })
  } catch (err) {
    if (err.message === 'INVITE_INVALID') return res.status(400).json({ ok: false, error: 'Invalid invite' })
    if (err.message === 'INVITE_CONSUMED') return res.status(400).json({ ok: false, error: 'Invite already consumed' })
    if (err.message === 'INVITE_EXPIRED') return res.status(400).json({ ok: false, error: 'Invite expired' })
    
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})
