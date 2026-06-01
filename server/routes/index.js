import path from 'node:path';
import { promises as fs } from 'node:fs';
import { setupLegacyRoutes } from '../../server_legacy.js';
import { authRouter } from './auth.js';
import { CAMPAIGNS_DIR } from '../config.js';
import { dbForCampaignBase } from '../db/index.js';
import { resolveCampaignBase } from '../utils.js';
import {
  acceptServerInvite,
  createInitialAdmin,
  createServerInvite,
  deleteServerInvite,
  deleteServerUser,
  getAdminStatus,
  listServerInvites,
  listServerUsers,
  loginAdmin,
  loginAnyUser,
  registerServerUser,
  resetServerUserPassword,
  revokeServerUserSessions,
  updateServerUserRole,
} from '../services/adminAuth.js';
// Add future modular routers here:
// import campaignRouter from './campaigns.js';

export function setupRoutes(app) {
  app.get('/api/admin/status', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await getAdminStatus()) });
    } catch (err) {
      console.error('Admin status error:', err);
      res.status(500).json({ ok: false, error: 'Failed to read admin status' });
    }
  });

  app.post('/api/admin/login', async (req, res) => {
    try {
      const session = await loginAdmin({
        username: req.body?.username,
        password: req.body?.password,
      });
      res.json({ ok: true, session });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Admin login error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Admin login failed' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const session = await loginAnyUser({
        username: req.body?.username,
        password: req.body?.password,
      });
      res.json({ ok: true, session });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Login error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Login failed' });
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const session = await registerServerUser({
        username: req.body?.username,
        displayName: req.body?.displayName,
        email: req.body?.email,
        password: req.body?.password,
      });
      res.json({ ok: true, session });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Register error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Registration failed' });
    }
  });

  app.post('/api/auth/accept-invite', async (req, res) => {
    try {
      const session = await acceptServerInvite({
        inviteToken: req.body?.inviteToken,
        username: req.body?.username,
        displayName: req.body?.displayName,
        password: req.body?.password,
      });
      res.json({ ok: true, session });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Accept invite error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Failed to accept invite' });
    }
  });

  app.get('/api/admin/users', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      res.json({ ok: true, users: await listServerUsers() });
    } catch (err) {
      console.error('List users error:', err);
      res.status(500).json({ ok: false, error: 'Failed to list users' });
    }
  });

  app.patch('/api/admin/users/:userId/role', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      const user = await updateServerUserRole({
        userId: req.params.userId,
        role: req.body?.role,
      });
      res.json({ ok: true, user });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Update user role error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Failed to update user role' });
    }
  });

  app.get('/api/admin/invites', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      res.json({ ok: true, invites: await listServerInvites() });
    } catch (err) {
      console.error('List invites error:', err);
      res.status(500).json({ ok: false, error: 'Failed to list invites' });
    }
  });

  app.post('/api/admin/invites', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      const invite = await createServerInvite({
        role: req.body?.role || 'dm',
        createdByUserId: req.user.id,
      });
      res.json({ ok: true, invite });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Create invite error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Failed to create invite' });
    }
  });

  app.delete('/api/admin/invites/:token', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      await deleteServerInvite({ token: req.params.token });
      res.json({ ok: true });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Delete invite error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Failed to delete invite' });
    }
  });

  app.delete('/api/admin/users/:userId', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      await deleteServerUser({ userId: req.params.userId });
      res.json({ ok: true });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Delete user error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Failed to delete user' });
    }
  });

  app.post('/api/admin/users/:userId/reset-password', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      const user = await resetServerUserPassword({ userId: req.params.userId, password: req.body?.password });
      res.json({ ok: true, user });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Reset password error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Failed to reset password' });
    }
  });

  app.delete('/api/admin/users/:userId/sessions', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      const result = await revokeServerUserSessions({ userId: req.params.userId });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Revoke sessions error:', err);
      res.status(500).json({ ok: false, error: err?.message || 'Failed to revoke sessions' });
    }
  });

  app.get('/api/server/users', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    if (!['admin', 'dm'].includes(req.user.role)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
      const users = await listServerUsers();
      res.json({ ok: true, users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/player/invites', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const entries = await fs.readdir(CAMPAIGNS_DIR, { withFileTypes: true }).catch(() => []);
      const invites = [];
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const metaRaw = await fs.readFile(path.join(CAMPAIGNS_DIR, entry.name, 'meta.json'), 'utf8');
          const meta = JSON.parse(metaRaw);
          const { base } = resolveCampaignBase(entry.name);
          const db = dbForCampaignBase(base);
          const rows = db.prepare(
            'SELECT token, dm_display_name, expires_at FROM invites WHERE target_server_user_id = ? AND consumed_at IS NULL AND expires_at > ?'
          ).all(req.user.id, now);
          for (const row of rows) {
            invites.push({
              campaignId: entry.name,
              campaignName: meta.name,
              dmDisplayName: row.dm_display_name || meta.ownerDisplayName || 'DM',
              inviteToken: row.token,
              expiresAt: row.expires_at,
            });
          }
        } catch { /* skip */ }
      }
      res.json({ ok: true, invites });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/player/campaigns', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const entries = await fs.readdir(CAMPAIGNS_DIR, { withFileTypes: true }).catch(() => []);
      const campaigns = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const metaRaw = await fs.readFile(path.join(CAMPAIGNS_DIR, entry.name, 'meta.json'), 'utf8');
          const meta = JSON.parse(metaRaw);
          const { base } = resolveCampaignBase(entry.name);
          const db = dbForCampaignBase(base);
          const member = db.prepare('SELECT display_name, role FROM users WHERE server_user_id = ?').get(req.user.id);
          if (member) {
            campaigns.push({
              id: entry.name,
              name: meta.name,
              createdAt: meta.createdAt,
              ownerDisplayName: meta.ownerDisplayName,
              role: member.role,
              displayName: member.display_name,
            });
          }
        } catch { /* skip unreadable campaigns */ }
      }
      res.json({ ok: true, campaigns });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/campaigns/:id/summary', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const { base } = resolveCampaignBase(req.params.id);
      const db = dbForCampaignBase(base);
      const getDocLen = (key) => {
        try {
          const row = db.prepare('SELECT content_json FROM campaign_documents WHERE campaign_id = ? AND doc_key = ?').get(req.params.id, key);
          const arr = row ? JSON.parse(row.content_json) : null;
          return Array.isArray(arr) ? arr.length : 0;
        } catch { return 0; }
      };
      const pendingApprovals = (() => {
        try {
          const row = db.prepare('SELECT content_json FROM campaign_documents WHERE campaign_id = ? AND doc_key = ?').get(req.params.id, 'approvals');
          const arr = row ? JSON.parse(row.content_json) : [];
          return Array.isArray(arr) ? arr.filter((a) => !a.approvedAt && !a.rejectedAt).length : 0;
        } catch { return 0; }
      })();
      const journalEntries = db.prepare('SELECT COUNT(*) as c FROM journal_entries WHERE campaign_id = ?').get(req.params.id)?.c ?? 0;
      res.json({ ok: true, sessions: getDocLen('gameSessions'), pcs: getDocLen('pcs'), pendingApprovals, journalEntries });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/campaigns/:id', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    const id = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid campaign id' });
    try {
      const campaignPath = path.join(CAMPAIGNS_DIR, id);
      await fs.rm(campaignPath, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      console.error('Delete campaign error:', err);
      res.status(500).json({ ok: false, error: err?.message || 'Failed to delete campaign' });
    }
  });

  app.post('/api/setup', async (req, res) => {
    try {
      const admin = await createInitialAdmin({
        username: req.body?.username,
        displayName: req.body?.displayName,
        password: req.body?.password,
      });
      res.json({ ok: true, message: 'Admin account created', admin });
    } catch (err) {
      console.error('Setup error:', err);
      res.status(Number(err?.statusCode) || 500).json({ ok: false, error: err?.message || 'Failed to create admin account' });
    }
  });

  app.use('/api/campaigns/:campaignId/auth', authRouter);
  
  // Mount legacy routes until they are separated
  setupLegacyRoutes(app);
}
