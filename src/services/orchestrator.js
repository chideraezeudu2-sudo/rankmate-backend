import { db } from '../db/client.js';
import { getPagesDueForCrawl, crawlPage } from './crawler.js';
import { autofixPage } from './technicalAutofixer.js';
import { optimizePage } from './contentOptimizer.js';
import { runContentGapPipeline } from './contentCreator.js';
import { linkNewContent } from './internalLinker.js';
import { checkCompetitors } from './competitorMonitor.js';

/**
 * Effort allocation follows the locked "optimize first, create second"
 * philosophy (~40% page improvements / 25% technical fixes / 20% internal
 * linking / 10% new pages / 5% monitoring) — in practice this means: run
 * technical fixes + optimization on every due page every cycle (cheap,
 * high-frequency), and only spend the expensive content-creation budget
 * when there's real headroom left in the plan's article cap.
 */
export async function runDailyCycle(siteId) {
  const { data: site, error } = await db.from('sites').select('*, accounts(plan)').eq('id', siteId).single();
  if (error) throw error;
  const plan = site.accounts?.plan ?? 'trial';

  const summary = { crawled: 0, technicalFixes: 0, pagesOptimized: 0, articlesDrafted: 0, linksCreated: 0, competitorChanges: 0 };

  const duePages = await getPagesDueForCrawl(siteId);
  for (const page of duePages) {
    const crawlResult = await crawlPage(page);
    summary.crawled++;

    const autofix = await autofixPage(page, crawlResult);
    summary.technicalFixes += autofix.fixed;

    const optimized = await optimizePage(page, crawlResult, plan);
    if (!optimized.skipped && optimized.changedCount > 0) summary.pagesOptimized++;
  }

  const contentResult = await runContentGapPipeline(siteId, plan);
  if (!contentResult.skipped) {
    summary.articlesDrafted = contentResult.drafted.length;
    for (const piece of contentResult.drafted) {
      const linked = await linkNewContent(siteId, piece);
      summary.linksCreated += linked.linksCreated;
    }
  }

  const competitorResult = await checkCompetitors(siteId, plan);
  if (!competitorResult.skipped) summary.competitorChanges = competitorResult.changesDetected;

  return summary;
}
