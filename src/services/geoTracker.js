import { db } from '../db/client.js';
import { runTask } from '../lib/modelRouter.js';
import { getBusinessProfile } from './intelligenceEngine.js';
import tiers from '../config/tiers.json' with { type: 'json' };

const PROVIDER_TASK = {
  openai: 'geo_query_openai',
  anthropic: 'geo_query_anthropic',
  perplexity: 'geo_query_perplexity',
};

function weekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Monday-start week
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

async function generateQueries(profile, count) {
  const raw = await runTask('business_profile', {
    systemPrompt: `Generate realistic buyer search queries someone would type into ChatGPT or Perplexity
when shopping for this kind of product. Respond ONLY with valid JSON: {"queries": ["...", ...]}`,
    userPrompt: `Product: ${profile.product_summary}\nUse cases: ${JSON.stringify(profile.use_cases)}\nCompetitors: ${JSON.stringify(profile.competitors)}\nGenerate ${count} queries.`,
    jsonMode: true,
  });
  return JSON.parse(raw).queries.slice(0, count);
}

async function extractPresence(rawResponse, brandName) {
  const raw = await runTask('geo_presence_extraction', {
    systemPrompt: `Given an AI assistant's answer to a buyer query, determine if the given brand is
mentioned, where (early/mid/late in the response), the framing (recommended/neutral/criticized), and
which competitor brands are also mentioned. Respond ONLY with valid JSON:
{"mentioned": bool, "position": <int or null>, "framing": "recommended"|"neutral"|"criticized"|null, "competitors_mentioned": ["..."]}`,
    userPrompt: `Brand: ${brandName}\n\nResponse to analyze:\n${rawResponse.slice(0, 3000)}`,
    jsonMode: true,
  });
  return JSON.parse(raw);
}

/**
 * Weekly batch job — NOT part of the real-time activity feed (see the
 * cost split decided in planning: GEO is cost-heavier per-query, so it
 * runs on a slower cadence and surfaces in the Growth Report instead).
 */
export async function runWeeklyGeoRefresh(siteId, plan = 'trial') {
  const config = tiers[plan] ?? tiers.trial;
  const profile = await getBusinessProfile(siteId);
  if (!profile) return { skipped: true, reason: 'no business profile yet' };

  const { data: site } = await db.from('sites').select('url').eq('id', siteId).single();
  const brandName = new URL(site.url).hostname.replace(/^www\./, '');

  const queries = await generateQueries(profile, config.geo_queries);
  const week = weekStart();
  const snapshots = [];

  for (const query of queries) {
    for (const provider of config.geo_providers) {
      const task = PROVIDER_TASK[provider];
      if (!task) continue; // e.g. google_ai_overview has no clean API — needs SERP scraping, not implemented in V1

      const response = await runTask(task, {
        systemPrompt: 'You are a helpful assistant answering a buyer question about software products.',
        userPrompt: query,
      });
      const presence = await extractPresence(response, brandName);

      const { data: row, error } = await db
        .from('geo_snapshots')
        .insert({
          site_id: siteId,
          week_start: week,
          query,
          provider,
          mentioned: presence.mentioned,
          position: presence.position,
          framing: presence.framing,
          competitors_mentioned: presence.competitors_mentioned ?? [],
          raw_response: response.slice(0, 5000),
        })
        .select()
        .single();
      if (error) throw error;
      snapshots.push(row);
    }
  }

  return { skipped: false, week, snapshotCount: snapshots.length };
}

export async function getGeoTrend(siteId, weeks = 8) {
  const { data, error } = await db
    .from('geo_snapshots')
    .select('*')
    .eq('site_id', siteId)
    .order('week_start', { ascending: false })
    .limit(weeks * 20);
  if (error) throw error;
  return data;
}
