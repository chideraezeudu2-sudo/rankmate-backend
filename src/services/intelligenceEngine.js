import { db } from '../db/client.js';
import { runTask } from '../lib/modelRouter.js';
import { logActivity } from './activityFeed.js';

const PROFILE_SYSTEM_PROMPT = `You are Rankmate's business-intelligence engine. Given raw page text from a
company's website, extract a structured profile. Respond ONLY with valid JSON in this exact shape:
{
  "product_summary": "one paragraph, what the product does and for whom",
  "features": ["short feature name", ...],
  "use_cases": ["short use case phrase", ...],
  "target_customers": ["ICP description", ...],
  "competitors": ["competitor name", ...],
  "seed_keywords": ["keyword phrase a buyer might search", ...]
}`;

/**
 * Builds the business profile the first time a site is added, or refreshes
 * it after a real content change is detected on a key page. This is a
 * one-shot cost per site, not a recurring one — see field_updated_at for
 * incremental tracking so later runs don't redo the whole thing from scratch.
 */
export async function buildBusinessProfile(siteId, { url, textContent }) {
  const raw = await runTask('business_profile', {
    systemPrompt: PROFILE_SYSTEM_PROMPT,
    userPrompt: `Site: ${url}\n\nPage text:\n${textContent.slice(0, 12000)}`,
    jsonMode: true,
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Business profile model did not return valid JSON');
  }

  const now = new Date().toISOString();
  const fieldTimestamps = Object.fromEntries(Object.keys(parsed).map((k) => [k, now]));

  const { data, error } = await db
    .from('business_profiles')
    .upsert(
      {
        site_id: siteId,
        ...parsed,
        field_updated_at: fieldTimestamps,
        last_full_analysis_at: now,
      },
      { onConflict: 'site_id' }
    )
    .select()
    .single();

  if (error) throw error;

  await logActivity({
    siteId,
    actionType: 'profile_built',
    description: `Built business profile: ${parsed.features?.length ?? 0} features, ${parsed.competitors?.length ?? 0} competitors identified`,
    refTable: 'business_profiles',
    refId: data.id,
  });

  return data;
}

export async function getBusinessProfile(siteId) {
  const { data, error } = await db.from('business_profiles').select('*').eq('site_id', siteId).maybeSingle();
  if (error) throw error;
  return data;
}
