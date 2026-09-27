import { db } from '../db/client.js';
import { runTask } from '../lib/modelRouter.js';
import { logActivity } from './activityFeed.js';
import tiers from '../config/tiers.json' with { type: 'json' };
import { capWindowStart, trialWindowExpired } from '../lib/periods.js';

/** Counts distinct pages optimized since the plan's cap window opened. */
async function countOptimizedPages(siteId, plan) {
  const since = await capWindowStart(siteId, plan);
  const { data, error } = await db
    .from('page_optimizations')
    .select('page_id, created_at, pages!inner(site_id)')
    .eq('pages.site_id', siteId)
    .gte('created_at', since);
  if (error) throw error;
  return new Set(data.map((r) => r.page_id)).size;
}

/**
 * Rewrites title + meta description + suggests an improved H1 for a page
 * that already HAS these fields (unlike Phase 2, which only fills gaps).
 * This is the "we clearly did something" proof the trial leans on.
 */
export async function optimizePage(page, crawlResult, plan = 'trial') {
  if (plan === 'trial' && (await trialWindowExpired(page.site_id))) {
    return { skipped: true, reason: 'trial window has ended' };
  }

  const cap = tiers[plan]?.pages_optimized_cap;
  if (cap !== null && cap !== undefined) {
    const already = await countOptimizedPages(page.site_id, plan);
    if (already >= cap) return { skipped: true, reason: `plan cap of ${cap} pages reached` };
  }

  const raw = await runTask('page_rewrite', {
    systemPrompt: `You are an SEO editor. Given a page's current title, meta description, and H1, propose improved
versions that are more compelling and keyword-relevant without changing what the page is about. Respond ONLY
with valid JSON: {"title": "...", "meta_description": "...", "h1": "..."}`,
    userPrompt: `URL: ${page.url}\nCurrent title: ${crawlResult.title}\nCurrent meta: ${crawlResult.metaDescription}\nCurrent H1: ${crawlResult.h1}\nPage text (for context): ${crawlResult.textContent.slice(0, 2000)}`,
    jsonMode: true,
  });

  let proposed;
  try {
    proposed = JSON.parse(raw);
  } catch {
    throw new Error(`page_rewrite did not return valid JSON for ${page.url}`);
  }

  const fields = [
    ['title', crawlResult.title, proposed.title],
    ['meta_description', crawlResult.metaDescription, proposed.meta_description],
    ['h1', crawlResult.h1, proposed.h1],
  ];

  let changedCount = 0;
  for (const [field, before, after] of fields) {
    if (!after || after === before) continue;
    await db.from('page_optimizations').insert({
      page_id: page.id,
      field,
      before_value: before || null,
      after_value: after,
      model_used: 'page_rewrite',
      status: 'applied',
    });
    changedCount++;
  }

  if (changedCount > 0) {
    await logActivity({
      siteId: page.site_id,
      actionType: 'page_optimized',
      description: `Improved ${changedCount} field(s) (title/meta/H1) on ${page.url}`,
      refTable: 'pages',
      refId: page.id,
    });
  }

  return { skipped: false, proposed, changedCount };
}
