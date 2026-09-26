import express from 'express';
import { db } from '../db/client.js';
import { crawlPage, registerPage, getPagesDueForCrawl } from '../services/crawler.js';
import { buildBusinessProfile, getBusinessProfile } from '../services/intelligenceEngine.js';
import { getRecentActivity } from '../services/activityFeed.js';

export const sitesRouter = express.Router();

/** Onboarding: connect a URL, crawl the homepage, build the initial business profile. */
sitesRouter.post('/', async (req, res) => {
  const { accountId, url, twitterHandle } = req.body;
  if (!accountId || !url) return res.status(400).json({ error: 'accountId and url are required' });

  try {
    const { data: site, error } = await db
      .from('sites')
      .insert({ account_id: accountId, url, twitter_handle: twitterHandle ?? null, status: 'onboarding' })
      .select()
      .single();
    if (error) throw error;

    const page = await registerPage(site.id, url, 'critical');
    const crawlResult = await crawlPage(page);
    const profile = await buildBusinessProfile(site.id, { url, textContent: crawlResult.textContent });

    await db.from('sites').update({ status: 'active' }).eq('id', site.id);

    res.json({ site, profile });
  } catch (err) {
    console.error('[sites] onboarding failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/** Runs the tiered crawl for whichever pages are due right now. */
sitesRouter.post('/:id/crawl', async (req, res) => {
  try {
    const due = await getPagesDueForCrawl(req.params.id);
    const results = [];
    for (const page of due) {
      results.push(await crawlPage(page));
    }
    res.json({ crawled: results.length, pages: due.map((p) => p.url) });
  } catch (err) {
    console.error('[sites] crawl failed:', err);
    res.status(500).json({ error: err.message });
  }
});

sitesRouter.get('/:id/profile', async (req, res) => {
  const profile = await getBusinessProfile(req.params.id);
  res.json(profile);
});

sitesRouter.get('/:id/activity', async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const events = await getRecentActivity(req.params.id, limit);
  res.json(events);
});
