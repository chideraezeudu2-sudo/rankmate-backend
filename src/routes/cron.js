import express from 'express';
import { runDailyForAllSites, runGeoForPaidSites, runCompetitorsForAllSites } from '../services/fleetOrchestrator.js';

export const cronRouter = express.Router();

/**
 * Cron endpoints. Render cron jobs hit these on a schedule so the system runs
 * without the founder doing anything.
 *
 * Protected by CRON_SECRET: these trigger real spending (LLM calls, and for GEO
 * real OpenAI/Anthropic/Perplexity calls), so they must not be openly callable.
 * Render cron jobs send the secret in an Authorization header.
 */
cronRouter.use((req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed in production: without a secret these endpoints would let
    // anyone burn provider budget.
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'CRON_SECRET is not configured; cron endpoints disabled' });
    }
    return next();
  }
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-cron-secret');
  if (provided !== secret) return res.status(401).json({ error: 'unauthorized' });
  next();
});

function guard(handler, label) {
  return async (req, res) => {
    try {
      const out = await handler(req);
      res.json(out);
    } catch (err) {
      console.error(`[cron] ${label} failed:`, err);
      res.status(500).json({ error: err.message });
    }
  };
}

/** Daily: crawl due pages, technical fixes, optimization, gap-driven content, linking, competitor checks. */
cronRouter.post('/daily', guard(() => runDailyForAllSites(), 'daily'));

/** Weekly: GEO sweep, paid plans only. Pass ?force=1 to re-run a week already covered. */
cronRouter.post('/geo', guard((req) => runGeoForPaidSites({ force: req.query.force === '1' }), 'geo'));

/** Daily: competitor sweep, per-plan cadence (daily/weekly/biweekly). */
cronRouter.post('/competitors', guard(() => runCompetitorsForAllSites(), 'competitors'));
