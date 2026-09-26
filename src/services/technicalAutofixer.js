import { db } from '../db/client.js';
import { runTask } from '../lib/modelRouter.js';
import { logActivity } from './activityFeed.js';

/**
 * Deterministic checks first — this is closer to a linter than an LLM task,
 * per the cost model (Phase 2 is meant to be near-free). Only meta
 * description / title / missing-H1 are auto-fixable text problems; broken
 * links and thin content are flagged but need the crawler's link graph or
 * human judgment, so they stay 'open' until Phase 5 (internal linking) or
 * a person looks at them.
 */
function detectIssues(page, crawlResult) {
  const issues = [];
  if (!crawlResult.title) issues.push({ issue_type: 'missing_title', description: `No <title> found on ${page.url}` });
  if (crawlResult.title && crawlResult.title.length > 60)
    issues.push({ issue_type: 'title_too_long', description: `Title is ${crawlResult.title.length} chars (recommend <60)` });
  if (!crawlResult.metaDescription) issues.push({ issue_type: 'missing_meta_description', description: `No meta description on ${page.url}` });
  if (!crawlResult.h1) issues.push({ issue_type: 'missing_h1', description: `No <h1> found on ${page.url}` });
  if (crawlResult.textContent.length < 300) issues.push({ issue_type: 'thin_content', description: `Only ~${crawlResult.textContent.length} chars of visible text` });
  return issues;
}

const AUTO_FIXABLE = new Set(['missing_title', 'title_too_long', 'missing_meta_description']);

async function generateFix(issueType, page, crawlResult) {
  const prompts = {
    missing_title: `Write a concise, compelling <title> tag (under 60 chars) for this page. URL: ${page.url}. Content: ${crawlResult.textContent.slice(0, 1500)}. Respond with ONLY the title text, nothing else.`,
    title_too_long: `Shorten this page title to under 60 characters while keeping its meaning: "${crawlResult.title}". Respond with ONLY the new title.`,
    missing_meta_description: `Write a compelling meta description (140-160 chars) for this page. URL: ${page.url}. Content: ${crawlResult.textContent.slice(0, 1500)}. Respond with ONLY the description text.`,
  };
  const result = await runTask('technical_fix', {
    systemPrompt: 'You are an SEO copywriter. Follow the instruction exactly and return only the requested text, no quotes, no preamble.',
    userPrompt: prompts[issueType],
  });
  return result.trim();
}

/** Runs detection + auto-fix generation for one already-crawled page. Returns counts for the orchestrator. */
export async function autofixPage(page, crawlResult) {
  const issues = detectIssues(page, crawlResult);
  let fixed = 0;

  for (const issue of issues) {
    const { data: issueRow, error } = await db
      .from('technical_issues')
      .insert({ page_id: page.id, issue_type: issue.issue_type, description: issue.description })
      .select()
      .single();
    if (error) throw error;

    if (AUTO_FIXABLE.has(issue.issue_type)) {
      const before = issue.issue_type === 'missing_meta_description' ? crawlResult.metaDescription : crawlResult.title;
      const after = await generateFix(issue.issue_type, page, crawlResult);
      const field = issue.issue_type === 'missing_meta_description' ? 'meta_description' : 'title';

      await db.from('page_optimizations').insert({
        page_id: page.id,
        field,
        before_value: before || null,
        after_value: after,
        model_used: 'technical_fix',
        status: 'applied',
      });
      await db.from('technical_issues').update({ status: 'fixed', fixed_at: new Date().toISOString() }).eq('id', issueRow.id);
      await logActivity({
        siteId: page.site_id,
        actionType: 'technical_fix',
        description: `Fixed ${issue.issue_type.replace(/_/g, ' ')} on ${page.url}`,
        refTable: 'page_optimizations',
        refId: issueRow.id,
      });
      fixed++;
    }
  }

  return { detected: issues.length, fixed };
}
