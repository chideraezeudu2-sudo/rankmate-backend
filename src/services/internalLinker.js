import { db } from '../db/client.js';
import { runTask } from '../lib/modelRouter.js';
import { logActivity } from './activityFeed.js';

/**
 * V1 uses cheap keyword-overlap matching rather than true vector embeddings —
 * good enough for "does this new article relate to that existing page" and
 * avoids standing up pgvector + an embeddings pipeline for the first pass.
 * Swap in real embeddings later by replacing scoreRelevance() only; nothing
 * else here needs to change.
 */
function scoreRelevance(text, query) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const haystack = text.toLowerCase();
  return words.filter((w) => haystack.includes(w)).length / Math.max(words.length, 1);
}

/** Links a freshly created content piece back into relevant existing pages, and vice versa. */
export async function linkNewContent(siteId, contentPiece) {
  const { data: pages, error } = await db.from('pages').select('id, url').eq('site_id', siteId);
  if (error) throw error;
  if (!pages.length) return { linksCreated: 0 };

  const scored = pages
    .map((p) => ({ page: p, score: scoreRelevance(p.url, contentPiece.target_query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  let created = 0;
  for (const { page } of scored) {
    const anchor = await runTask('internal_linking', {
      systemPrompt: 'Write a short, natural anchor text (3-6 words) for a link. Respond with ONLY the anchor text.',
      userPrompt: `Link from a page about "${page.url}" to a new article titled "${contentPiece.title}" targeting "${contentPiece.target_query}".`,
    });

    await db.from('internal_links').insert({
      site_id: siteId,
      from_page_id: page.id,
      to_page_id: null, // content_piece isn't a crawled `page` row until/if it's actually published
      anchor_text: anchor.trim(),
    });
    created++;
  }

  if (created > 0) {
    await logActivity({
      siteId,
      actionType: 'internal_links_added',
      description: `Added ${created} internal link(s) pointing to "${contentPiece.title}"`,
      refTable: 'content_pieces',
      refId: contentPiece.id,
    });
  }

  return { linksCreated: created };
}
