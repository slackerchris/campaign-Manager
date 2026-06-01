import express from 'express';
import { corsMiddleware, authMiddleware } from './server/middleware/index.js';
import { setupRoutes } from './server/routes/index.js';
import { installConsoleCapture, requestLogMiddleware } from './server/services/diagnostics.js';

const app = express();
installConsoleCapture();
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use('/api', requestLogMiddleware);
app.use('/api', authMiddleware);

setupRoutes(app);

const PORT = process.env.API_PORT || 8790;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
