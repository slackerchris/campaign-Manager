import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import { dbForCampaignBase, runInTx } from '../db/index.js'
import { readJson, resolveCampaignBase } from '../utils.js'
import { loginAdmin } from '../services/adminAuth.js'

export const authRouter = express.Router({ mergeParams: true })

authRouter.post('/admin-login', async (req, res) => {
  try {
    const session = await loginAdmin({
      username: req.body?.username,
      password: req.body?.password,
    })
    res.json({ ok: true, session })
  } catch (err) {
    const status = Number(err?.statusCode) || 500
    if (status >= 500) console.error(err)
    res.status(status).json({ ok: false, error: err?.message || 'Admin login failed' })
  }
})

authRouter.post('/invites', async (req, res) => {
  // TODO: Add proper auth middleware check here once implemented in Phase 2
  // For now, we will assume req.user is populated by a middleware we'll write next
  try {
    if (!req.user || req.user.role !== 'dm') {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can create invites' })
    }
    const { campaignId } = req.params
    const { role = 'player' } = req.body

    const { base } = resolveCampaignBase(campaignId)
    const meta = await readJson(path.join(base, 'meta.json'), null)
    if (String(meta?.ownerUserId || '') !== String(req.user.id || '')) {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can create invites' })
    }
    const db = dbForCampaignBase(base)
    const now = Date.now()
    db.prepare(`
      INSERT OR IGNORE INTO users (id, display_name, role, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, req.user.displayName || 'DM', 'dm', now, now)
    db.prepare('UPDATE users SET display_name = ?, role = ?, last_seen_at = ? WHERE id = ?')
      .run(req.user.displayName || 'DM', 'dm', now, req.user.id)
    
    const token = crypto.randomBytes(16).toString('hex')
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

authRouter.post('/direct-invite', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'dm') {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can send invites' })
    }
    const { campaignId } = req.params
    const { targetServerUserId } = req.body
    if (!targetServerUserId) return res.status(400).json({ ok: false, error: 'targetServerUserId required' })

    const { base } = resolveCampaignBase(campaignId)
    const meta = await readJson(path.join(base, 'meta.json'), null)
    if (String(meta?.ownerUserId || '') !== String(req.user.id || '')) {
      return res.status(403).json({ ok: false, error: 'Only the campaign DM can send invites' })
    }

    const db = dbForCampaignBase(base)
    const now = Date.now()

    // Check not already a member
    const existing = db.prepare('SELECT id FROM users WHERE server_user_id = ?').get(targetServerUserId)
    if (existing) return res.status(409).json({ ok: false, error: 'User is already in this campaign' })

    // Check no pending directed invite already
    const pending = db.prepare(
      'SELECT token FROM invites WHERE target_server_user_id = ? AND consumed_at IS NULL AND expires_at > ?'
    ).get(targetServerUserId, now)
    if (pending) return res.status(409).json({ ok: false, error: 'A pending invite already exists for this user' })

    const token = crypto.randomBytes(16).toString('hex')
    const expiresAt = now + (1000 * 60 * 60 * 24 * 30)

    db.prepare(`
      INSERT OR IGNORE INTO users (id, display_name, role, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, req.user.displayName || 'DM', 'dm', now, now)

    db.prepare(`
      INSERT INTO invites (token, role, created_by, expires_at, target_server_user_id, dm_display_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, 'player', req.user.id, expiresAt, targetServerUserId, req.user.displayName || 'DM')

    res.json({ ok: true, invite: { token, expiresAt } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

authRouter.post('/accept-direct-invite', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })

    const { campaignId } = req.params
    const { inviteToken, displayName } = req.body
    if (!inviteToken) return res.status(400).json({ ok: false, error: 'inviteToken required' })

    const { base } = resolveCampaignBase(campaignId)
    const db = dbForCampaignBase(base)
    const now = Date.now()

    let sessionToken = null, userId = null, role = null, expiresAt = null

    runInTx(db, () => {
      const invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(inviteToken)
      if (!invite) throw new Error('INVITE_INVALID')
      if (invite.consumed_at) throw new Error('INVITE_CONSUMED')
      if (invite.expires_at < now) throw new Error('INVITE_EXPIRED')
      if (invite.target_server_user_id && invite.target_server_user_id !== req.user.id) {
        throw new Error('INVITE_NOT_FOR_YOU')
      }

      userId = crypto.randomUUID()
      role = invite.role
      const finalDisplayName = String(displayName || req.user.displayName || '').trim() || 'Player'

      db.prepare(`
        INSERT INTO users (id, display_name, role, created_at, last_seen_at, server_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, finalDisplayName, role, now, now, req.user.id)

      db.prepare('UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE token = ?').run(now, userId, inviteToken)

      sessionToken = crypto.randomBytes(32).toString('hex')
      expiresAt = now + (1000 * 60 * 60 * 24 * 30)
      db.prepare('INSERT INTO sessions_auth (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sessionToken, userId, now, expiresAt)
    })

    res.json({ ok: true, session: { token: sessionToken, userId, role, expiresAt } })
  } catch (err) {
    if (err.message === 'INVITE_INVALID') return res.status(400).json({ ok: false, error: 'Invalid invite' })
    if (err.message === 'INVITE_CONSUMED') return res.status(400).json({ ok: false, error: 'Invite already used' })
    if (err.message === 'INVITE_EXPIRED') return res.status(400).json({ ok: false, error: 'Invite expired' })
    if (err.message === 'INVITE_NOT_FOR_YOU') return res.status(403).json({ ok: false, error: 'This invite is for a different user' })
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
        INSERT INTO users (id, display_name, role, created_at, last_seen_at, server_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, displayName.trim(), role, now, now, req.user?.id || null)

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
