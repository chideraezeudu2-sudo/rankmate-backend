import Stripe from 'stripe';
import { db } from '../db/client.js';
import prices from '../config/prices.json' with { type: 'json' };

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Plan for a given Stripe Price ID, derived from config/prices.json (plan ->
 * price). Inverted here so webhook handling can look up by price ID.
 */
export const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(prices)
    .filter(([key]) => !key.startsWith('$'))
    .map(([plan, priceId]) => [priceId, plan]),
);

export function priceIdForPlan(plan) {
  return prices[plan] ?? null;
}

export async function createCheckoutSession({ accountId, priceId, successUrl, cancelUrl }) {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY not set');
  const { data: account } = await db.from('accounts').select('*').eq('id', accountId).single();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: account?.stripe_customer_id || undefined,
    customer_email: account?.stripe_customer_id ? undefined : account.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { account_id: accountId },
  });
  return session;
}

/**
 * Stripe billing portal for managing/cancelling a subscription. Requires the
 * account to already have a stripe_customer_id (set on first checkout).
 */
export async function createPortalSession({ accountId, returnUrl }) {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY not set');
  const { data: account } = await db.from('accounts').select('*').eq('id', accountId).single();
  if (!account) throw new Error('account not found');
  if (!account.stripe_customer_id) throw new Error('no subscription yet - check out first');

  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: returnUrl,
  });
  return session;
}

/**
 * The account's current plan plus the caps that plan enforces, so the frontend
 * can show usage without duplicating the tier table.
 */
export async function getAccountTier(accountId, tiers) {
  const { data: account, error } = await db
    .from('accounts')
    .select('id, email, plan, stripe_customer_id')
    .eq('id', accountId)
    .single();
  if (error) throw error;

  const plan = account.plan ?? 'trial';
  const config = tiers[plan] ?? tiers.trial;
  return { account, plan, caps: config };
}

/**
 * Verifies and handles a Stripe webhook event. Call this from the raw-body
 * route (see routes/billing.js) — signature verification needs the raw
 * request body, not the JSON-parsed one.
 */
export async function handleWebhook(rawBody, signature) {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY not set');
  const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const accountId = session.metadata?.account_id;
      if (accountId) {
        await db.from('accounts').update({ stripe_customer_id: session.customer }).eq('id', accountId);
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub = event.data.object;
      const priceId = sub.items.data[0]?.price?.id;
      const plan = PRICE_TO_PLAN[priceId] ?? null;
      if (plan) {
        await db.from('accounts').update({ plan }).eq('stripe_customer_id', sub.customer);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await db.from('accounts').update({ plan: 'trial' }).eq('stripe_customer_id', sub.customer);
      break;
    }
  }

  return { received: true, type: event.type };
}
