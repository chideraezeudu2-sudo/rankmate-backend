import express from 'express';
import { sitesRouter } from './routes/sites.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/sites', sitesRouter);

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`rankmate-backend listening on :${port}`));
