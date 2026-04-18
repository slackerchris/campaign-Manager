import re
import os

with open('server.mjs', 'r') as f:
    code = f.read()

# Create dirs
for d in ['server', 'server/routes', 'server/services', 'server/db', 'server/middleware']:
    os.makedirs(d, exist_ok=True)

# 1. Extract middleware (CORS & Auth)
middleware_code = """
import cors from 'cors';
import crypto from 'node:crypto';

const _corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['https://dnd.throne.middl.earth', 'https://dnd.middl.earth', 'http://localhost:5173', 'http://localhost:4173'];

export const corsMiddleware = cors({ origin: _corsOrigins, credentials: true });

const APP_TOKEN = (process.env.APP_TOKEN || '').trim();
const _appTokenBuf = APP_TOKEN ? Buffer.from(APP_TOKEN) : null;

export const authMiddleware = (req, res, next) => {
  if (!_appTokenBuf) return next();
  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let valid = false;
  if (token) {
    try {
      const tokenBuf = Buffer.from(token);
      valid = tokenBuf.length === _appTokenBuf.length && crypto.timingSafeEqual(tokenBuf, _appTokenBuf);
    } catch { valid = false; }
  }
  if (!valid) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
};
"""
with open('server/middleware/index.js', 'w') as f:
    f.write(middleware_code)

# rename server.mjs -> server_legacy.js
os.rename('server.mjs', 'server_legacy.js')

# rewrite server.mjs
server_mjs = """import express from 'express';
import { corsMiddleware, authMiddleware } from './server/middleware/index.js';
import { setupRoutes } from './server/routes/index.js';

const app = express();
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use('/api', authMiddleware);

setupRoutes(app);

const PORT = process.env.API_PORT || 8790;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
"""
with open('server.mjs', 'w') as f:
    f.write(server_mjs)

