import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { authRouter } from './auth.js';
import { CAMPAIGNS_DIR } from '../config.js';
import { dbForCampaignBase } from '../db/index.js';
import { resolveCampaignBase } from '../utils.js';
import { ensureSqlSchema } from '../db/migrations.js';
import { db as pgDb, checkConnection } from '../db/postgres/pool.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getMigrationStatus } from '../db/postgres/migrate.js';
import * as campaignsRepo from '../db/postgres/repositories/campaigns.repo.js';
import * as membersRepo from '../db/postgres/repositories/members.repo.js';
import * as campaignInvitesRepo from '../db/postgres/repositories/campaign-invites.repo.js';
import * as lexiconRepo from '../db/postgres/repositories/lexicon.repo.js';
import * as trackersRepo from '../db/postgres/repositories/trackers.repo.js';
import * as journalRepo from '../db/postgres/repositories/journal.repo.js';
import * as bardTalesRepo from '../db/postgres/repositories/bard-tales.repo.js';
import * as campaignDocumentsRepo from '../db/postgres/repositories/campaign-documents.repo.js';
import { setupCampaignRoutes } from './campaigns.js';
import { setupSettingsRoutes } from './settings.js';
import { setupHealthRoutes } from './health.js';
import { setupLegacyProxyRoutes } from './legacy.js';
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

function slugify(text = '') {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function campaignShape(row) {
  return {
    id: row.slug,
    pgId: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    ownerDisplayName: row.owner_display_name,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : row.created_at,
  };
}

export function setupRoutes(app) {

  // ── DB health ────────────────────────────────────────────────────────────────

  app.get('/api/admin/db-health', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      const [connection, migrations] = await Promise.all([checkConnection(), getMigrationStatus(pgDb)]);
      res.json({ ok: true, connection, migrations });
    } catch (err) {
      console.error('DB health error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Setup + admin auth ───────────────────────────────────────────────────────

  app.get('/api/admin/status', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await getAdminStatus()) });
    } catch (err) {
      console.error('Admin status error:', err);
      res.status(500).json({ ok: false, error: 'Failed to read admin status' });
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
      res.status(Number(err?.statusCode) || 500).json({ ok: false, error: err?.message || 'Failed to create admin account' });
    }
  });

  app.post('/api/admin/login', rateLimit(5, 60_000), async (req, res) => {
    try {
      const session = await loginAdmin({ username: req.body?.username, password: req.body?.password });
      res.json({ ok: true, session });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Admin login error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Admin login failed' });
    }
  });

  app.post('/api/auth/login', rateLimit(5, 60_000), async (req, res) => {
    try {
      const session = await loginAnyUser({ username: req.body?.username, password: req.body?.password });
      res.json({ ok: true, session });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Login error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Login failed' });
    }
  });

  app.post('/api/auth/register', rateLimit(10, 60_000), async (req, res) => {
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

  // ── Admin: users ─────────────────────────────────────────────────────────────

  app.get('/api/admin/users', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      res.json({ ok: true, users: await listServerUsers() });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to list users' });
    }
  });

  app.patch('/api/admin/users/:userId/role', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      const user = await updateServerUserRole({ userId: req.params.userId, role: req.body?.role });
      res.json({ ok: true, user });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('Update user role error:', err);
      res.status(status).json({ ok: false, error: err?.message || 'Failed to update user role' });
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
      res.status(500).json({ ok: false, error: err?.message || 'Failed to revoke sessions' });
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

  // ── Admin: server invites ─────────────────────────────────────────────────────

  app.get('/api/admin/invites', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      res.json({ ok: true, invites: await listServerInvites() });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to list invites' });
    }
  });

  app.post('/api/admin/invites', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    try {
      const invite = await createServerInvite({ role: req.body?.role || 'dm', createdByUserId: req.user.id });
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

  // ── Server user search (for DM invite flow) ───────────────────────────────────

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

  // ── Campaigns ─────────────────────────────────────────────────────────────────

  app.get('/api/campaigns', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const all = await campaignsRepo.listAllCampaigns();
      if (req.user.role === 'admin') {
        return res.json({ ok: true, campaigns: all.map(campaignShape) });
      }
      if (req.user.role === 'dm') {
        return res.json({ ok: true, campaigns: all.filter((c) => c.owner_user_id === req.user.id).map(campaignShape) });
      }
      res.json({ ok: true, campaigns: [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/campaigns', async (req, res) => {
    if (req.user?.role !== 'dm') return res.status(403).json({ ok: false, error: 'Only DMs can create campaigns' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Campaign name required' });

    const slug = `${slugify(name) || 'campaign'}-${crypto.randomUUID().slice(0, 6)}`;
    try {
      // Write to Postgres
      const campaign = await campaignsRepo.createCampaign({
        slug,
        name,
        ownerUserId: req.user.id,
        ownerDisplayName: req.user.displayName || 'DM',
      });

      // Add DM as member
      await membersRepo.addMember({
        campaignId: campaign.id,
        userId: req.user.id,
        displayName: req.user.displayName || 'DM',
        role: 'dm',
      });

      // Create filesystem directories + SQLite schema (still needed by legacy routes)
      const campaignDir = path.join(CAMPAIGNS_DIR, slug);
      await fs.mkdir(campaignDir, { recursive: true });
      await fs.writeFile(
        path.join(campaignDir, 'meta.json'),
        JSON.stringify({ id: slug, pgId: campaign.id, name, ownerUserId: req.user.id, ownerDisplayName: req.user.displayName || 'DM', createdAt: campaign.created_at.getTime() }, null, 2),
      );
      const sqliteDb = dbForCampaignBase(campaignDir);
      ensureSqlSchema(sqliteDb);

      res.json({ ok: true, campaign: campaignShape(campaign) });
    } catch (err) {
      console.error('Create campaign error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/campaigns/:id', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    const slug = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return res.status(400).json({ ok: false, error: 'Invalid campaign id' });
    try {
      const campaign = await campaignsRepo.findCampaignBySlug(slug);
      if (campaign) await campaignsRepo.deleteCampaign(campaign.id);
      await fs.rm(path.join(CAMPAIGNS_DIR, slug), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      console.error('Delete campaign error:', err);
      res.status(500).json({ ok: false, error: err?.message || 'Failed to delete campaign' });
    }
  });

  // ── Campaign meta + summary ───────────────────────────────────────────────────

  app.get('/api/campaigns/:id/meta', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const slug = String(req.params.id || '').trim();
      const campaign = await campaignsRepo.findCampaignBySlug(slug);
      if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' });

      // Membership check — admin sees all, others must be a member
      if (req.user.role !== 'admin') {
        const member = await membersRepo.findMember(campaign.id, req.user.id);
        if (!member) return res.status(403).json({ ok: false, error: 'Not a member of this campaign' });
      }

      res.json({ ok: true, campaign: campaignShape(campaign) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/campaigns/:id/summary', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const slug = String(req.params.id || '').trim();
      const campaign = await campaignsRepo.findCampaignBySlug(slug);
      if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' });

      if (req.user.role !== 'admin') {
        const member = await membersRepo.findMember(campaign.id, req.user.id);
        if (!member) return res.status(403).json({ ok: false, error: 'Not a member of this campaign' });
      }

      const [journalEntries, sessions, pcs, approvalsRaw] = await Promise.all([
        journalRepo.countJournalEntries(campaign.id),
        campaignDocumentsRepo.countArrayDocument(campaign.id, 'gameSessions'),
        campaignDocumentsRepo.countArrayDocument(campaign.id, 'pcs'),
        campaignDocumentsRepo.loadDocument(campaign.id, 'approvals'),
      ]);
      const approvals = Array.isArray(approvalsRaw) ? approvalsRaw : [];
      const pendingApprovals = approvals.filter((a) => !a.approvedAt && !a.rejectedAt).length;
      res.json({ ok: true, sessions, pcs, pendingApprovals, journalEntries });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Campaign state (full Postgres read) ──────────────────────────────────────

  app.get('/api/campaigns/:id/state', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const slug = String(req.params.id || '').trim();
      const campaign = await campaignsRepo.findCampaignBySlug(slug);
      if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' });

      if (req.user.role !== 'admin') {
        const member = await membersRepo.findMember(campaign.id, req.user.id);
        if (!member) return res.status(403).json({ ok: false, error: 'Not a member of this campaign' });
      }

      const pgId = campaign.id;
      const [{ entities, aliases }, trackerRows, journal, bardsTales, docs] = await Promise.all([
        lexiconRepo.loadEntities(pgId),
        trackersRepo.loadTrackers(pgId),
        journalRepo.loadJournalEntries(pgId),
        bardTalesRepo.loadBardTales(pgId),
        campaignDocumentsRepo.loadAllDocuments(pgId),
      ]);

      res.json({
        ok: true,
        npcs: docs.npcs ?? [],
        quests: docs.quests ?? [],
        quotes: docs.quotes ?? [],
        journal,
        storyJournal: (docs.storyJournal?.entries) ?? [],
        pcs: docs.pcs ?? [],
        gameSessions: docs.gameSessions ?? [],
        approvals: docs.approvals ?? [],
        lexicon: docs.lexicon ?? [],
        lexiconEntities: entities,
        entityAliases: aliases,
        trackerRows,
        places: docs.places ?? [],
        bardsTales,
        dmSneakPeek: docs.dmSneakPeek ?? [],
        dmNotes: docs.dmNotes?.text ?? '',
      });
    } catch (err) {
      console.error('Campaign state error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Player: campaigns + invites ───────────────────────────────────────────────

  app.get('/api/player/campaigns', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const rows = await membersRepo.listCampaignsForUser(req.user.id);
      res.json({
        ok: true,
        campaigns: rows.map((r) => ({
          id: r.slug,
          pgId: r.id,
          name: r.name,
          createdAt: r.created_at instanceof Date ? r.created_at.getTime() : r.created_at,
          ownerDisplayName: r.owner_display_name,
          role: r.role,
          displayName: r.display_name,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/player/invites', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' });
    try {
      const rows = await campaignInvitesRepo.listPendingInvitesForUser(req.user.id);
      res.json({
        ok: true,
        invites: rows.map((r) => ({
          campaignId: r.campaign_slug,
          campaignName: r.campaign_name,
          dmDisplayName: r.dm_display_name || r.owner_display_name || 'DM',
          inviteToken: r.token,
          expiresAt: r.expires_at instanceof Date ? r.expires_at.getTime() : r.expires_at,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Campaign auth routes ───────────────────────────────────────────────────────

  app.use('/api/campaigns/:campaignId/auth', authRouter);

  // Settings & secrets routes (Postgres-backed, shadows legacy key/config routes)
  setupSettingsRoutes(app);

  // Health routes (Postgres-backed, shadows legacy health routes)
  setupHealthRoutes(app);

  // Campaign content routes (strangled from legacy)
  setupCampaignRoutes(app);

  // New auth-guarded proxy routes (wrapping legacy business logic)
  setupLegacyProxyRoutes(app);

}
