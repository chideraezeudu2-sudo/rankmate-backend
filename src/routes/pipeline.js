import express from 'express';
import { runDailyCycle } from '../services/orchestrator.js';
import { runWeeklyGeoRefresh, getGeoTrend } from '../services/geoTracker.js';
import { addCompetitorWatch, checkCompetitors } from '../services/competitorMonitor.js';
import { db } from '../db/client.js';
import tiers from '../config/tiers.json' with { type: 'json' };

export const pipelineRouter = express.Router();

async function planFor(siteId) {
  const { data } = await db.from('sites').select('accounts(plan)').eq('id', siteId).single();
  return data?.accounts?.plan ?? 'trial';
}

/** Runs the full daily cycle (crawl due pages -> technical fixes -> optimize -> gap-driven content -> linking -> competitor check). */
pipelineRouter.post('/:id/run-daily', async (req, res) => {
  try {
    const summary = await runDailyCycle(req.params.id);
    res.json(summary);
  } catch (err) {
    console.error('[pipeline] daily cycle failed:', err);
    res.status(500).json({ error: err.message });
  }
});

pipelineRouter.post('/:id/geo/refresh', async (req, res) => {
  try {
    const plan = await planFor(req.params.id);
    if (!tiers[plan]?.geo_enabled) {
      return res.status(402).json({ error: 'GEO / AI-search visibility is available on Growth and Scale plans only' });
    }
    const result = await runWeeklyGeoRefresh(req.params.id, plan);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

pipelineRouter.get('/:id/geo/trend', async (req, res) => {
  const trend = await getGeoTrend(req.params.id);
  res.json(trend);
});

pipelineRouter.post('/:id/competitors', async (req, res) => {
  const { competitorUrl } = req.body;
  if (!competitorUrl) return res.status(400).json({ error: 'competitorUrl is required' });
  const watch = await addCompetitorWatch(req.params.id, competitorUrl);
  res.json(watch);
});

pipelineRouter.post('/:id/competitors/check', async (req, res) => {
  try {
    const plan = await planFor(req.params.id);
    const result = await checkCompetitors(req.params.id, plan);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
