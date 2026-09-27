import express from 'express';
import {
  createCheckoutSession,
  createPortalSession,
  getAccountTier,
  priceIdForPlan,
  handleWebhook,
} from '../services/billing.js';
import tiers from '../config/tiers.json' with { type: 'json' };

export const billingRouter = express.Router();

/**
 * Starts a checkout for a plan. Takes a plan NAME (starter/growth/scale) and
 * resolves the Stripe Price ID server-side — accepting a raw priceId from the
 * client would let anyone check out against an arbitrary price.
 */
billingRouter.post('/checkout', express.json(), async (req, res) => {
  try {
    const { accountId, plan, successUrl, cancelUrl } = req.body;
    if (!accountId || !plan) return res.status(400).json({ error: 'accountId and plan are required' });

    const priceId = priceIdForPlan(plan);
    if (!priceId) return res.status(400).json({ error: `unknown plan: ${plan}` });
    if (!successUrl || !cancelUrl) return res.status(400).json({ error: 'successUrl and cancelUrl are required' });

    const session = await createCheckoutSession({ accountId, priceId, successUrl, cancelUrl });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Stripe billing portal, for managing or cancelling an existing subscription. */
billingRouter.post('/portal', express.json(), async (req, res) => {
  try {
    const { accountId, returnUrl } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    const session = await createPortalSession({ accountId, returnUrl: returnUrl || undefined });
    res.json({ url: session.url });
  } catch (err) {
    // "no subscription yet" is client state, not a server fault.
    const status = /no subscription yet/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

/** Current plan and the caps it enforces. */
billingRouter.get('/tier', async (req, res) => {
  try {
    const accountId = req.query.accountId;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    res.json(await getAccountTier(accountId, tiers));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** The plans and their caps, for a pricing page. */
billingRouter.get('/plans', (_req, res) => {
  res.json(
    Object.entries(tiers).map(([plan, caps]) => ({
      plan,
      monthly_price_usd: caps.monthly_price_usd ?? null,
      geo_enabled: caps.geo_enabled,
      pages_optimized_cap: caps.pages_optimized_cap,
      articles_published_cap: caps.articles_published_cap,
      competitor_cadence_days: caps.competitor_cadence_days,
      checkout_available: Boolean(priceIdForPlan(plan)),
    })),
  );
});

// Stripe requires the RAW body for signature verification — must not run through express.json().
billingRouter.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await handleWebhook(req.body, req.headers['stripe-signature']);
    res.json(result);
  } catch (err) {
    console.error('[billing] webhook verification failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});
