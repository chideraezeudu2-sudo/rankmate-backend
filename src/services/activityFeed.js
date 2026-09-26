import { db } from '../db/client.js';

/**
 * Logs one action to the real-time activity feed.
 * This is the trial's core "wow moment" — every classic-SEO action
 * (technical fix, rewrite, published page, internal link) fires here
 * the moment it happens. GEO does NOT log here — it's a weekly batch,
 * surfaced in the Growth Report instead (see geoTracker.js).
 */
export async function logActivity({ siteId, actionType, description, refTable = null, refId = null }) {
  const { data, error } = await db
    .from('activity_events')
    .insert({ site_id: siteId, action_type: actionType, description, ref_table: refTable, ref_id: refId })
    .select()
    .single();

  if (error) {
    console.error(`[activityFeed] failed to log ${actionType} for site ${siteId}:`, error.message);
    return null;
  }
  return data;
}

export async function getRecentActivity(siteId, limit = 50) {
  const { data, error } = await db
    .from('activity_events')
    .select('*')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}
