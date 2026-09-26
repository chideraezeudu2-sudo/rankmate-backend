import crypto from 'node:crypto';
import { db } from '../db/client.js';
import { logActivity } from './activityFeed.js';
import tiers from '../config/tiers.json' with { type: 'json' };

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function addCompetitorWatch(siteId, competitorUrl) {
  const { data, error } = await db
    .from('competitor_watches')
    .upsert({ site_id: siteId, competitor_url: competitorUrl }, { onConflict: 'site_id,competitor_url' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Tiered cadence per plan (biweekly/weekly/daily) — trial and Starter
 * don't get this at all (competitor_cadence_days: null), matching the
 * original build-reliability call: cheap to run, but still gated as a
 * Growth/Scale differentiator.
 */
export async function checkCompetitors(siteId, plan = 'trial') {
  const cadenceDays = tiers[plan]?.competitor_cadence_days;
  if (!cadenceDays) return { skipped: true, reason: `${plan} plan has no competitor monitoring` };

  const { data: watches, error } = await db.from('competitor_watches').select('*').eq('site_id', siteId);
  if (error) throw error;

  const due = watches.filter((w) => {
    if (!w.last_checked_at) return true;
    const daysSince = (Date.now() - new Date(w.last_checked_at).getTime()) / 86400000;
    return daysSince >= cadenceDays;
  });

  let changesDetected = 0;
  for (const watch of due) {
    let html;
    try {
      const res = await fetch(watch.competitor_url, { headers: { 'User-Agent': 'RankmateBot/0.1' } });
      html = await res.text();
    } catch (err) {
      console.error(`[competitorMonitor] failed to fetch ${watch.competitor_url}:`, err.message);
      continue;
    }

    const newHash = hashText(html);
    const changed = watch.last_hash && newHash !== watch.last_hash;

    await db.from('competitor_watches').update({ last_hash: newHash, last_checked_at: new Date().toISOString() }).eq('id', watch.id);

    if (changed) {
      await db.from('competitor_events').insert({
        site_id: siteId,
        competitor_url: watch.competitor_url,
        event_type: 'content_changed',
        description: `Detected a change on ${watch.competitor_url}`,
      });
      changesDetected++;
    }
  }

  return { skipped: false, checked: due.length, changesDetected };
}
