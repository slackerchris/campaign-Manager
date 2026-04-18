import crypto from 'node:crypto'
import { dbForCampaignBase } from '../db/index.js'
import { resolveCampaignBase } from '../utils.js'
import { APP_TOKEN } from '../config.js'

export const authMiddleware = (req, res, next) => {
  const authHeader = String(req.headers['authorization'] || '')
  if (!authHeader.startsWith('Bearer ')) {
    // If no token is provided but they're hitting a campaign endpoint, reject
    if (req.originalUrl.includes('/campaigns/')) {
       return res.status(401).json({ ok: false, error: 'Unauthorized: Missing token' })
    }
    return next()
  }

  const token = authHeader.slice(7).trim()
  
  // Phase 2: "The old APP_TOKEN becomes a 'DM bootstrap token' used only to create the first DM account or recover access."
  // If the APP_TOKEN matches, we bypass as super-admin (used for /bootstrap)
  if (APP_TOKEN) {
    const appTokenBuf = Buffer.from(APP_TOKEN)
    const tokenBuf = Buffer.from(token)
    try {
      if (tokenBuf.length === appTokenBuf.length && crypto.timingSafeEqual(tokenBuf, appTokenBuf)) {
        req.user = { role: 'dm', id: 'bootstrap-superadmin', bootstrap: true }
        return next()
      }
    } catch { /* ignore and parse as user session token */ }
  }

  // Attempt to extract campaignId from the URL (e.g. /api/campaigns/:id)
  const match = req.originalUrl.match(/\/campaigns\/([^/?]+)/)
  if (!match) {
    // Endpoints like /api/health or generic /api/campaigns (list)
    return next()
  }

  const campaignId = match[1]
  try {
    const { base, campaignId: normalizedId } = resolveCampaignBase(campaignId)
    const db = dbForCampaignBase(base)
    
    // Look up session in DB
    const session = db.prepare(`
      SELECT s.user_id, s.expires_at, u.role
      FROM sessions_auth s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token)

    if (!session) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid session token' })
    }

    if (session.expires_at < Date.now()) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: Session expired' })
    }

    // Attach user to request
    req.user = {
      id: session.user_id,
      role: session.role,
      campaign_id: normalizedId
    }

    // Optionally update last_seen_at (debounced or strictly, this is simple so we just do it)
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), session.user_id)

    next()
  } catch (err) {
    console.error('Auth middleware error:', err)
    return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid campaign or database error' })
  }
}
