
import cors from 'cors';
import crypto from 'node:crypto';

const _corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['https://dnd.throne.middl.earth', 'https://dnd.middl.earth', 'http://localhost:5173', 'http://localhost:4173'];

export const corsMiddleware = cors({ origin: _corsOrigins, credentials: true });

export { authMiddleware } from './auth.js';
