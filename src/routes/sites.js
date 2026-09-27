import express from 'express';
import { db } from '../db/client.js';
import { crawlPage, registerPage, getPagesDueForCrawl } from '../services/crawler.js';
import { buildBusinessProfile, getBusinessProfile } from '../services/intelligenceEngine.js';
import { getRecentActivity } from '../services/activityFeed.js';
import tiers from '../config/tiers.json' with { type: 'json' };

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

/**
 * Weekly growth report, in business terms rather than SEO jargon.
 *
 * Reports leading indicators only — work actually completed (issues fixed,
 * pages improved, pieces published, links built) and observed AI-search
 * presence. It deliberately does NOT promise ranking or traffic lift: those
 * depend on factors outside the system's control, so claiming them would be
 * dishonest.
 */
sitesRouter.get('/:id/report', async (req, res) => {
  const siteId = req.params.id;
  const days = Math.min(Number(req.query.days) || 7, 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const { data: site } = await db
      .from('sites')
      .select('id, url, status, accounts(plan)')
      .eq('id', siteId)
      .single();
    if (!site) return res.status(404).json({ error: 'site not found' });

    const plan = site.accounts?.plan ?? 'trial';
    const config = tiers[plan] ?? tiers.trial;

    // issues and optimizations hang off page_id, so resolve the site's pages first.
    const { data: pages } = await db.from('pages').select('id').eq('site_id', siteId);
    const pageIds = (pages ?? []).map((p) => p.id);
    const inPages = pageIds.length ? pageIds : ['00000000-0000-0000-0000-000000000000'];

    const [issuesFixed, issuesOpen, optimizations, pieces, published, links, activity] =
      await Promise.all([
        db.from('technical_issues').select('id', { count: 'exact', head: true })
          .in('page_id', inPages).eq('status', 'fixed').gte('fixed_at', since),
        db.from('technical_issues').select('id', { count: 'exact', head: true })
          .in('page_id', inPages).eq('status', 'open'),
        db.from('page_optimizations').select('id', { count: 'exact', head: true })
          .in('page_id', inPages).gte('created_at', since),
        db.from('content_pieces').select('id', { count: 'exact', head: true })
          .eq('site_id', siteId).gte('created_at', since),
        db.from('content_pieces').select('id', { count: 'exact', head: true })
          .eq('site_id', siteId).eq('status', 'published').gte('created_at', since),
        db.from('internal_links').select('id', { count: 'exact', head: true })
          .eq('site_id', siteId).gte('created_at', since),
        db.from('activity_events').select('action_type, description, created_at')
          .eq('site_id', siteId).gte('created_at', since)
          .order('created_at', { ascending: false }).limit(200),
      ]);

    // AI-search presence is paid-only, and only reported when it was measured.
    let aiVisibility = null;
    if (config.geo_enabled) {
      const { data: snaps } = await db
        .from('geo_snapshots')
        .select('mentioned, provider, query')
        .eq('site_id', siteId)
        .gte('created_at', since);
      if (snaps?.length) {
        const mentioned = snaps.filter((s) => s.mentioned).length;
        aiVisibility = {
          queries_tested: snaps.length,
          times_mentioned: mentioned,
          mention_rate: Number((mentioned / snaps.length).toFixed(3)),
          providers: [...new Set(snaps.map((s) => s.provider))],
        };
      }
    }

    const activityEvents = activity?.data ?? [];

    res.json({
      site: { id: site.id, url: site.url, status: site.status },
      period: { days, since, until: new Date().toISOString() },
      plan,
      summary: {
        technical_issues_fixed: issuesFixed.count ?? 0,
        technical_issues_still_open: issuesOpen.count ?? 0,
        existing_pages_improved: optimizations.count ?? 0,
        new_pieces_written: pieces.count ?? 0,
        new_pieces_published: published.count ?? 0,
        internal_links_added: links.count ?? 0,
        total_actions: activityEvents.length,
      },
      ai_search_visibility: aiVisibility,
      note:
        'These are leading indicators of work completed, not promised ranking or traffic outcomes.',
      recent_activity: activityEvents.slice(0, 20),
    });
  } catch (err) {
    console.error('[sites] report failed:', err);
    res.status(500).json({ error: err.message });
  }
});
