import express from 'express';
import { setupLegacyRoutes } from '../../server_legacy.js';
import { authRouter } from './auth.js';
import { APP_TOKEN } from '../config.js';
import { persistAppToken } from '../services/keys.js';
// Add future modular routers here:
// import campaignRouter from './campaigns.js';

export function setupRoutes(app) {
  app.post('/api/setup', async (req, res) => {
    try {
      if (APP_TOKEN) {
        return res.status(403).json({ ok: false, error: 'Server is already claimed. APP_TOKEN is permanently locked.' });
      }
      const { token } = req.body;
      if (!token || typeof token !== 'string' || token.length < 8) {
        return res.status(400).json({ ok: false, error: 'Setup requires a strong APP_TOKEN (min 8 chars).' });
      }
      await persistAppToken(token);
      res.json({ ok: true, message: 'Server claimed successfully' });
    } catch (err) {
      console.error('Setup error:', err);
      res.status(500).json({ ok: false, error: 'Failed to claim server' });
    }
  });

  app.use('/api/campaigns/:campaignId/auth', authRouter);
  
  // Mount legacy routes until they are separated
  setupLegacyRoutes(app);
}
