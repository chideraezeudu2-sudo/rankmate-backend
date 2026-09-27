import { db } from '../db/client.js';
import { runDailyCycle } from '../services/orchestrator.js';
import { runWeeklyGeoRefresh } from '../services/geoTracker.js';
import { checkCompetitors } from '../services/competitorMonitor.js';
import tiers from '../config/tiers.json' with { type: 'json' };

/**
 * Fleet-level orchestrator. Rankmate is autonomous: the founder never triggers
 * a job. This is what the cron endpoints call — it walks every active site and
 * runs whatever is due for that site's plan.
 *
 * "Due" is derived from timestamps already on the rows (sites.updated_at,
 * geo_snapshots.week_start, competitor_watches.last_checked_at) rather than new
 * state columns, so no schema change is needed.
 */

const ACTIVE_SITE_LIMIT = 500;

async function activeSites() {
  const { data, error } = await db
    .from('sites')
    .select('id, url, account_id, accounts(plan)')
    .eq('status', 'active')
    .limit(ACTIVE_SITE_LIMIT);
  if (error) throw error;
  return data ?? [];
}

const planOf = (site) => site.accounts?.plan ?? 'trial';

function mondayOf(date = new Date()) {
  const d = new Date(date);
  const diff = (d.getUTCDay() + 6) % 7; // Monday-start week
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/** Daily cycle for every active site. */
export async function runDailyForAllSites() {
  const sites = await activeSites();
  const results = [];

  for (const site of sites) {
    try {
      const summary = await runDailyCycle(site.id);
      results.push({ siteId: site.id, plan: planOf(site), ok: true, summary });
    } catch (err) {
      console.error(`[fleet] daily cycle failed for ${site.id}:`, err);
      results.push({ siteId: site.id, plan: planOf(site), ok: false, error: err.message });
    }
  }

  return { ranAt: new Date().toISOString(), sites: sites.length, results };
}

/**
 * Weekly GEO sweep — paid plans only. This is the expensive job, so it is
 * gated twice: the plan must have geo_enabled, and a site that already has a
 * snapshot for the current week is skipped. Trial/Starter never appear here.
 */
export async function runGeoForPaidSites({ force = false } = {}) {
  const sites = await activeSites();
  const week = mondayOf();
  const results = [];

  for (const site of sites) {
    const plan = planOf(site);
    const config = tiers[plan] ?? tiers.trial;

    if (!config.geo_enabled) {
      results.push({ siteId: site.id, plan, skipped: true, reason: 'geo not on this plan' });
      continue;
    }

    if (!force) {
      const { data: existing } = await db
        .from('geo_snapshots')
        .select('id')
        .eq('site_id', site.id)
        .eq('week_start', week)
        .limit(1);
      if (existing?.length) {
        results.push({ siteId: site.id, plan, skipped: true, reason: `already ran for week ${week}` });
        continue;
      }
    }

    try {
      const out = await runWeeklyGeoRefresh(site.id, plan);
      results.push({ siteId: site.id, plan, ok: true, ...out });
    } catch (err) {
      console.error(`[fleet] GEO failed for ${site.id}:`, err);
      results.push({ siteId: site.id, plan, ok: false, error: err.message });
    }
  }

  return { ranAt: new Date().toISOString(), week, sites: sites.length, results };
}

/**
 * Competitor sweep. Per-site cadence by plan (Starter biweekly, Growth weekly,
 * Scale daily), compared against the watch's own last_checked_at. Trial has no
 * cadence, so it is skipped. checkCompetitors already re-checks the cadence
 * internally; the pre-filter here just avoids pointless work.
 */
export async function runCompetitorsForAllSites() {
  const sites = await activeSites();
  const now = Date.now();
  const results = [];

  for (const site of sites) {
    const plan = planOf(site);
    const cadenceDays = tiers[plan]?.competitor_cadence_days;

    if (!cadenceDays) {
      results.push({ siteId: site.id, plan, skipped: true, reason: 'no competitor cadence on this plan' });
      continue;
    }

    const { data: watches } = await db
      .from('competitor_watches')
      .select('last_checked_at')
      .eq('site_id', site.id);
    if (!watches?.length) {
      results.push({ siteId: site.id, plan, skipped: true, reason: 'no competitors registered' });
      continue;
    }

    const due = watches.some((w) => {
      if (!w.last_checked_at) return true;
      const ageDays = (now - new Date(w.last_checked_at).getTime()) / 86_400_000;
      return ageDays >= cadenceDays;
    });
    if (!due) {
      results.push({ siteId: site.id, plan, skipped: true, reason: 'checked recently' });
      continue;
    }

    try {
      const out = await checkCompetitors(site.id, plan);
      results.push({ siteId: site.id, plan, ok: true, ...out });
    } catch (err) {
      console.error(`[fleet] competitor check failed for ${site.id}:`, err);
      results.push({ siteId: site.id, plan, ok: false, error: err.message });
    }
  }

  return { ranAt: new Date().toISOString(), sites: sites.length, results };
}
