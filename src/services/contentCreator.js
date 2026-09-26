import { db } from '../db/client.js';
import { runTask } from '../lib/modelRouter.js';
import { logActivity } from './activityFeed.js';
import { getBusinessProfile } from './intelligenceEngine.js';
import tiers from '../config/tiers.json' with { type: 'json' };

const GAP_SYSTEM_PROMPT = `You are Rankmate's content strategist. Given a business profile and a list of pages
the site already has, propose content gaps worth filling — comparison pages, "alternative to X" pages, and
use-case pages that map to something the product actually does. Skip anything that would duplicate an
existing page or that has no real product tie-in. Respond ONLY with valid JSON:
{"gaps": [{"target_query": "...", "title": "...", "gap_reason": "..."}]}`;

async function findContentGaps(profile, existingUrls, maxGaps) {
  const raw = await runTask('article_generation', {
    systemPrompt: GAP_SYSTEM_PROMPT,
    userPrompt: `Business profile:\n${JSON.stringify(profile, null, 2)}\n\nExisting pages:\n${existingUrls.join('\n')}\n\nPropose up to ${maxGaps} real gaps.`,
    jsonMode: true,
  });
  const parsed = JSON.parse(raw);
  return (parsed.gaps || []).slice(0, maxGaps);
}

async function draftArticle(profile, gap) {
  const body = await runTask('article_generation', {
    systemPrompt: `You are a technical content writer for a SaaS product. Write a genuinely useful,
well-structured article (600-900 words) targeting the given query. No fluff, no fabricated stats,
no claims the business profile doesn't support. Plain markdown, start with an H1.`,
    userPrompt: `Product: ${profile.product_summary}\nTarget query: ${gap.target_query}\nWorking title: ${gap.title}\nWhy this gap matters: ${gap.gap_reason}`,
  });
  return body;
}

/**
 * Runs the gap-driven content pipeline for a site, capped by plan.
 * NOTE ON PUBLISHING: this writes finished drafts to content_pieces with
 * status 'draft'. Actually pushing a new page live onto a customer's real
 * site (WordPress, Webflow, custom CMS, static site repo, etc.) needs a
 * per-site publish adapter that was never specified in planning — every
 * customer's site is a different platform. Until that adapter exists,
 * "published_url" stays null and status stays 'draft'; wire in the
 * adapter here once you decide which platform(s) to support first.
 */
export async function runContentGapPipeline(siteId, plan = 'trial') {
  const cap = tiers[plan]?.articles_published_cap;
  if (cap !== null && cap !== undefined) {
    const { count, error: countErr } = await db
      .from('content_pieces')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', siteId);
    if (countErr) throw countErr;
    if (count >= cap) return { skipped: true, reason: `plan cap of ${cap} articles reached` };
  }

  const profile = await getBusinessProfile(siteId);
  if (!profile) return { skipped: true, reason: 'no business profile yet' };

  const { data: pages, error: pagesErr } = await db.from('pages').select('url').eq('site_id', siteId);
  if (pagesErr) throw pagesErr;

  const remainingSlots = cap ? cap - (await db.from('content_pieces').select('id', { count: 'exact', head: true }).eq('site_id', siteId)).count : 3;
  const gaps = await findContentGaps(profile, pages.map((p) => p.url), Math.max(1, remainingSlots));

  const drafted = [];
  for (const gap of gaps) {
    const body = await draftArticle(profile, gap);
    const { data: piece, error } = await db
      .from('content_pieces')
      .insert({
        site_id: siteId,
        target_query: gap.target_query,
        gap_reason: gap.gap_reason,
        title: gap.title,
        status: 'draft',
        model_used: 'article_generation',
      })
      .select()
      .single();
    if (error) throw error;

    await logActivity({
      siteId,
      actionType: 'content_drafted',
      description: `Drafted new article: "${gap.title}" (targeting "${gap.target_query}")`,
      refTable: 'content_pieces',
      refId: piece.id,
    });
    drafted.push({ ...piece, body });
  }

  return { skipped: false, drafted };
}
