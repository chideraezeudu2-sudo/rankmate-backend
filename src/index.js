import express from 'express';
import { sitesRouter } from './routes/sites.js';
import { pipelineRouter } from './routes/pipeline.js';
import { billingRouter } from './routes/billing.js';

const app = express();

// Billing's webhook route needs the raw body, so it's mounted before the
// global express.json() middleware and does its own body parsing.
app.use('/billing', billingRouter);

app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/sites', sitesRouter);
app.use('/sites', pipelineRouter);

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`rankmate-backend listening on :${port}`));
