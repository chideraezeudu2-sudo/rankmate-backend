import { db } from '../db/client.js';

/** First instant of the current UTC month. Paid caps reset on this boundary. */
export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Start of the window a plan's caps apply to. Paid plans reset monthly; the
 * trial is a one-shot window, so its caps accumulate from trial start instead.
 * Without this, counts would be lifetime totals and a Starter customer would
 * hit their "per month" ceiling once and never be able to do work again.
 */
export async function capWindowStart(siteId, plan) {
  if (plan !== 'trial') return monthStart();
  const { data } = await db
    .from('sites')
    .select('accounts(trial_started_at)')
    .eq('id', siteId)
    .single();
  return data?.accounts?.trial_started_at ?? monthStart();
}

/**
 * Whether a trial site is outside its free window. A trial with no window
 * stamped is started now rather than treated as expired, so an account created
 * before this check existed is not locked out of its own trial.
 */
export async function trialWindowExpired(siteId) {
  const { data } = await db
    .from('sites')
    .select('accounts(id, trial_started_at, trial_ends_at)')
    .eq('id', siteId)
    .single();

  const acct = data?.accounts;
  if (!acct) return false;

  if (!acct.trial_ends_at) {
    const start = new Date();
    const end = new Date(start.getTime() + 14 * 24 * 3600 * 1000);
    await db
      .from('accounts')
      .update({ trial_started_at: start.toISOString(), trial_ends_at: end.toISOString() })
      .eq('id', acct.id);
    return false;
  }

  return new Date(acct.trial_ends_at).getTime() < Date.now();
}
