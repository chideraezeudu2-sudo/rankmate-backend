import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { db } from '../db/client.js';
import { logActivity } from './activityFeed.js';

const CRAWL_INTERVAL_HOURS = { critical: 24, standard: 24 * 7, low: 24 * 30 };

function hashContent(html) {
  return crypto.createHash('sha256').update(html).digest('hex');
}

/**
 * Fetches a page as plain HTTP first (cheap). Only flags it as
 * JS-rendered if the fetched body looks empty/shell-like — a real
 * headless-browser fallback (Browserless or similar) gets wired in
 * later, not in V1, per the cost-hack list.
 */
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RankmateBot/0.1 (+https://rankmate.app/bot)' },
    redirect: 'follow',
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const bodyText = $('body').text().trim();
  const looksJsRendered = bodyText.length < 200 && html.length > 500;

  return {
    status: res.status,
    html,
    title: $('title').first().text().trim(),
    metaDescription: $('meta[name="description"]').attr('content') || '',
    h1: $('h1').first().text().trim(),
    textContent: bodyText,
    looksJsRendered,
  };
}

/** Returns which tracked pages are due for a crawl right now, based on their tier. */
export async function getPagesDueForCrawl(siteId) {
  const { data: pages, error } = await db.from('pages').select('*').eq('site_id', siteId);
  if (error) throw error;

  const now = Date.now();
  return pages.filter((page) => {
    if (!page.last_crawled_at) return true;
    const hoursSince = (now - new Date(page.last_crawled_at).getTime()) / 3600000;
    return hoursSince >= CRAWL_INTERVAL_HOURS[page.page_tier];
  });
}

/** Crawls one page, updates its row, and logs an activity event only if content actually changed. */
export async function crawlPage(page) {
  const result = await fetchPage(page.url);
  const newHash = hashContent(result.html);
  const changed = newHash !== page.content_hash;

  await db
    .from('pages')
    .update({
      content_hash: newHash,
      last_crawled_at: new Date().toISOString(),
      last_changed_at: changed ? new Date().toISOString() : page.last_changed_at,
      is_js_rendered: result.looksJsRendered,
    })
    .eq('id', page.id);

  if (changed && page.last_crawled_at) {
    // Only log "detected a change" for re-crawls, not first-time discovery.
    await logActivity({
      siteId: page.site_id,
      actionType: 'page_changed',
      description: `Detected a content change on ${page.url}`,
      refTable: 'pages',
      refId: page.id,
    });
  }

  return { ...result, changed };
}

/** Registers a new URL to track, defaulting to 'standard' tier unless told otherwise. */
export async function registerPage(siteId, url, pageTier = 'standard') {
  const { data, error } = await db
    .from('pages')
    .upsert({ site_id: siteId, url, page_tier: pageTier }, { onConflict: 'site_id,url' })
    .select()
    .single();
  if (error) throw error;
  return data;
}
