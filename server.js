const express = require('express');
const path    = require('path');

const STRIPE_SECRET_KEY = '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';

const stripe = require('stripe')(STRIPE_SECRET_KEY);
const app    = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json()(req, res, next);
});

app.use(express.static(path.join(__dirname)));

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', customerEmail, items } = req.body;
    if (!amount || amount < 50) return res.status(400).json({ error: 'Invalid amount' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      receipt_email: customerEmail,
      automatic_payment_methods: { enabled: true },
      metadata: {
        store: 'GBL Gifts LLC',
        items: JSON.stringify((items || []).map(i => `${i.qty}x ${i.title}`).join(', ').substring(0, 490)),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!webhookSecret) return res.json({ received: true });

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      console.log(`Payment succeeded: ${intent.id} $${(intent.amount / 100).toFixed(2)}`);
    }
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.json({ received: true });
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GBL Gifts running on port ${PORT}`));
