import express from 'express';
import { createCheckoutSession, handleWebhook } from '../services/billing.js';

export const billingRouter = express.Router();

billingRouter.post('/checkout', express.json(), async (req, res) => {
  try {
    const { accountId, priceId, successUrl, cancelUrl } = req.body;
    const session = await createCheckoutSession({ accountId, priceId, successUrl, cancelUrl });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
