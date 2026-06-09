/**
 * GBL Gifts LLC — Stripe Payment Backend
 * ─────────────────────────────────────────
 * SETUP:
 *   1. npm install
 *   2. Set your LIVE secret key below (sk_live_...)
 *      Get it from: https://dashboard.stripe.com/apikeys
 *   3. node server.js
 *
 * DEPLOY TO PRODUCTION:
 *   - Railway:  railway up
 *   - Render:   push to GitHub, connect repo
 *   - Heroku:   git push heroku main
 *   Set PORT env var on your host if needed (defaults to 3000)
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');

// ── REPLACE THIS WITH YOUR LIVE SECRET KEY ──────────
const STRIPE_SECRET_KEY = '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';
// ────────────────────────────────────────────────────

const stripe = require('stripe')(STRIPE_SECRET_KEY);
const app    = express();

// Allow requests from your domain in production
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
}));

// Parse JSON for all routes except /webhook (needs raw body)
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json()(req, res, next);
});

// Serve the HTML site as a static file
app.use(express.static(path.join(__dirname)));

// ── POST /create-payment-intent ──────────────────────
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', customerEmail, items } = req.body;

    if (!amount || amount < 50) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,                    // cents (e.g. 1299 = $12.99)
      currency,
      receipt_email: customerEmail,
      automatic_payment_methods: { enabled: true },
      metadata: {
        store:    'GBL Gifts LLC',
        items:    JSON.stringify(
          (items || []).map(i => `${i.qty}x ${i.title}`).join(', ').substring(0, 490)
        ),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook (optional — for order confirmations) ──
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_YOUR_WEBHOOK_SECRET';

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    console.log(`✅ Payment succeeded: ${intent.id}  $${(intent.amount / 100).toFixed(2)}  ${intent.receipt_email || ''}`);
    // TODO: Send confirmation email / update inventory / create shipping label
  }

  res.json({ received: true });
});

// ── Health check ─────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', store: 'GBL Gifts LLC' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎁 GBL Gifts server running → http://localhost:${PORT}`);
  console.log(`   Mode: ${STRIPE_SECRET_KEY.startsWith('sk_live') ? '🟢 LIVE' : '🟡 TEST'}\n`);
});
