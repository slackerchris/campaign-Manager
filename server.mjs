import express from 'express';
import { promises as fs } from 'node:fs';
import { corsMiddleware, authMiddleware } from './server/middleware/index.js';
import { setupRoutes } from './server/routes/index.js';
import { installConsoleCapture, requestLogMiddleware } from './server/services/diagnostics.js';
import { db as pgDb } from './server/db/postgres/pool.js';
import { migrateToLatest } from './server/db/postgres/migrate.js';
import { DATABASE_URL, CAMPAIGNS_DIR } from './server/config.js';
import { loadRuntimeSettingsFromPg } from './server/services/settings.js';

async function start() {
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to your .env file.');
    process.exit(1);
  }

  console.log('Running database migrations...');
  await migrateToLatest(pgDb);
  await loadRuntimeSettingsFromPg();
  await fs.mkdir(CAMPAIGNS_DIR, { recursive: true });

  const app = express();
  installConsoleCapture();
  app.use(corsMiddleware);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', requestLogMiddleware);
  app.use('/api', authMiddleware);

  setupRoutes(app);

  const PORT = process.env.API_PORT || 8790;
  app.listen(PORT, () => console.log(`API running on port ${PORT}`));
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
