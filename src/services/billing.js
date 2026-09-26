import Stripe from 'stripe';
import { db } from '../db/client.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Fill these in with real Stripe Price IDs once the products exist in the Stripe dashboard.
export const PRICE_TO_PLAN = {
  price_starter_placeholder: 'starter',
  price_growth_placeholder: 'growth',
  price_scale_placeholder: 'scale',
};

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
