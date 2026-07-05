const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const _rlPkg = require('express-rate-limit');
const rateLimit = _rlPkg.rateLimit || _rlPkg.default || _rlPkg;  // works across v6/v7 export shapes

// Secret key is set as an environment variable in Railway — never in this file
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error('ERROR: STRIPE_SECRET_KEY environment variable is not set.');
  process.exit(1);
}

const stripe = require('stripe')(STRIPE_SECRET_KEY);
const app    = express();

// Behind Railway's proxy — needed so rate limiting sees the real client IP
app.set('trust proxy', 1);

// Rate limiters (card-testing / brute-force / abuse protection)
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000, max: 12,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again shortly.' },
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts — try again later.' },
});

// Product catalog — single source of truth for prices (never trust the browser)
const CATALOG = {};
JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'))
  .forEach(p => { CATALOG[p.sku] = p; });

const SHIPPING = 5.99;
const FREE_SHIP_MIN = 35;
const SITE = 'https://www.gblgifts.com';

function itemPrice(prod, vars) {
  let price = prod.price;
  if (prod.varPrices && vars) {
    for (const [vName, map] of Object.entries(prod.varPrices)) {
      const sel = vars[vName];
      if (sel != null && map[sel] != null) price = map[sel];
    }
  }
  return price;
}

// ── Site-wide discount (managed from the admin dashboard) ─────────────
// Stored in discount.json next to this file. Shape: {mode, value, updatedAt}
//   mode 'off'      -> no discount
//   mode 'percent'  -> value % off every item
//   mode 'amount'   -> value $ off every item (clamped so nothing drops below $0.50)
const DISCOUNT_FILE = path.join(__dirname, 'discount.json');
let DISCOUNT = { mode: 'off', value: 0 };
try {
  if (fs.existsSync(DISCOUNT_FILE)) DISCOUNT = JSON.parse(fs.readFileSync(DISCOUNT_FILE, 'utf8'));
} catch (e) { console.error('Could not read discount.json:', e.message); }

function discountedPrice(price) {
  if (!DISCOUNT || DISCOUNT.mode === 'off' || !(DISCOUNT.value > 0)) return price;
  let p = price;
  if (DISCOUNT.mode === 'percent') p = price * (1 - DISCOUNT.value / 100);
  else if (DISCOUNT.mode === 'amount') p = price - DISCOUNT.value;
  if (p < 0.50) p = 0.50;                 // never below Stripe's $0.50 minimum
  return Math.round(p * 100) / 100;
}

function computeTotalCents(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return null;
  let sub = 0;
  for (const it of items) {
    const prod = CATALOG[String(it.sku)];
    const qty  = parseInt(it.qty, 10);
    if (!prod || !Number.isInteger(qty) || qty < 1 || qty > 99) return null;
    sub += discountedPrice(itemPrice(prod, it.vars)) * qty;
  }
  const ship = sub >= FREE_SHIP_MIN ? 0 : SHIPPING;
  return Math.round((sub + ship) * 100);
}

// Security headers (see securityheaders.com)
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com https://pay.google.com https://*.stripe.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://api.stripe.com https://js.stripe.com https://*.stripe.com https://pay.google.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com https://pay.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

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

// Don't expose source, config, data, or backup files as static downloads
app.use((req, res, next) => {
  if (/(?:^|\/)(?:server\.js|package(?:-lock)?\.json|products\.json|discount\.json|\.env)$|\.(?:bak[\w.\-]*|md|csv|docx?|log|map)$/i.test(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'gbl-gifts-website.html'));
});

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Per-product landing pages with schema.org markup (indexable by Google)
app.get('/p/:sku', (req, res) => {
  const prod = CATALOG[req.params.sku];
  if (!prod || prod.sku === 'TEST-001') return res.status(404).send('Not found');
  const url = `${SITE}/p/${prod.sku}`;
  const dp = discountedPrice(prod.price);
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: prod.title, sku: prod.sku, image: prod.image || undefined,
    description: prod.desc, brand: { '@type': 'Brand', name: 'GBL Gifts' },
    offers: { '@type': 'Offer', price: dp.toFixed(2), priceCurrency: 'USD',
      availability: 'https://schema.org/InStock', url,
      shippingDetails: { '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: SHIPPING, currency: 'USD' },
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' } } }
  };
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(prod.title)} – GBL Gifts</title>
<meta name="description" content="${esc(prod.desc.slice(0,155))}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(prod.title)}">
<meta property="og:type" content="product">
${prod.image ? `<meta property="og:image" content="${esc(prod.image)}">` : ''}
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>body{font-family:sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#111}
img{max-width:100%;border-radius:12px}a.buy{display:inline-block;background:#6B21C8;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin-top:16px}</style>
</head><body>
<p><a href="/">← GBL Gifts – all ${Object.keys(CATALOG).length - 1} gift ideas</a></p>
<h1>${esc(prod.title)}</h1>
<p><strong>${dp < prod.price ? `<span style="text-decoration:line-through;opacity:.6">$${prod.price.toFixed(2)}</span> $${dp.toFixed(2)}` : `$${prod.price.toFixed(2)}`}</strong> · ${esc(prod.category)} · Free US shipping over $${FREE_SHIP_MIN}</p>
${prod.image ? `<img src="${esc(prod.image)}" alt="${esc(prod.title)}">` : ''}
<p>${esc(prod.desc)}</p>
<a class="buy" href="/?p=${encodeURIComponent(prod.sku)}">View &amp; buy in store</a>
</body></html>`);
});

// Facebook/Instagram Shop checkout handoff → forward the cart to the storefront.
// Meta calls /checkout?products=SKU:QTY,SKU:QTY&coupon=CODE
app.get('/checkout', (req, res) => {
  const qs = new URLSearchParams();
  if (req.query.products) qs.set('products', String(req.query.products));
  if (req.query.coupon)   qs.set('coupon',   String(req.query.coupon));
  res.redirect('/?' + qs.toString());
});

app.get('/sitemap.xml', (req, res) => {
  const urls = [`${SITE}/`].concat(
    Object.values(CATALOG).filter(p => p.sku !== 'TEST-001').map(p => `${SITE}/p/${p.sku}`));
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>');
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
});

// Public: storefront reads this on load to show the sale price / strikethrough.
app.get('/api/discount', (req, res) => res.json({ mode: DISCOUNT.mode, value: DISCOUNT.value }));

app.post('/create-payment-intent', checkoutLimiter, async (req, res) => {
  try {
    const { currency = 'usd', customerEmail, items, shipping } = req.body;
    // Amount is computed here from the catalog — the client's amount is ignored.
    const amount = computeTotalCents(items);
    if (amount === null || amount < 50) return res.status(400).json({ error: 'Invalid order' });

    // One metadata line per item: "2x Gargoyle Topper [0437] (Background Color: Black)"
    const metadata = { store: 'GBL Gifts LLC' };
    items.slice(0, 20).forEach((i, n) => {
      const prod = CATALOG[i.sku];
      const vars = Object.entries(i.vars || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      metadata[`item_${n + 1}`] = `${i.qty}x ${prod.title} [${i.sku}]${vars ? ` (${vars})` : ''}`.substring(0, 490);
    });

    const params = {
      amount,
      currency,
      receipt_email: customerEmail,
      automatic_payment_methods: { enabled: true },
      metadata,
    };
    // US-only shipping — flat $5.99 doesn't cover international rates
    const shipCountry = shipping && shipping.address && shipping.address.country;
    if (shipCountry && String(shipCountry).toUpperCase() !== 'US') {
      return res.status(400).json({ error: 'Sorry, we currently ship to U.S. addresses only.' });
    }
    if (shipping && shipping.address && shipping.address.line1) {
      params.shipping = {
        name: String(shipping.name || '').substring(0, 100),
        address: {
          line1: String(shipping.address.line1 || '').substring(0, 200),
          city: String(shipping.address.city || '').substring(0, 100),
          state: String(shipping.address.state || '').substring(0, 50),
          postal_code: String(shipping.address.postal_code || '').substring(0, 20),
          country: String(shipping.address.country || 'US').substring(0, 2),
        },
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(params);

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

// ── Orders dashboard ──────────────────────────────────
// Data routes are protected by ADMIN_KEY (set in Railway → service → Variables).
const ADMIN_KEY = process.env.ADMIN_KEY || '';
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'ADMIN_KEY is not set on the server' });
  const supplied = req.headers['x-admin-key'] || req.query.key || '';
  if (!safeEqual(supplied, ADMIN_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/admin/api/orders', adminLimiter, adminAuth, async (req, res) => {
  try {
    const out = [];
    let starting_after;
    for (let page = 0; page < 3; page++) {
      const batch = await stripe.paymentIntents.list({ limit: 100, ...(starting_after ? { starting_after } : {}) });
      for (const pi of batch.data) {
        if (pi.status !== 'succeeded') continue;
        const items = [];
        if (pi.metadata) {
          Object.keys(pi.metadata).filter(k => /^item_\d+$/.test(k)).sort()
            .forEach(k => items.push(pi.metadata[k]));
          if (!items.length && pi.metadata.items) items.push(pi.metadata.items);
        }
        out.push({
          id: pi.id,
          date: new Date(pi.created * 1000).toISOString(),
          amount: pi.amount / 100,
          email: pi.receipt_email || '',
          shipping: pi.shipping || null,
          items,
          in_production: pi.metadata && pi.metadata.in_production ? pi.metadata.in_production : '',
          shipped: pi.metadata && pi.metadata.shipped ? pi.metadata.shipped : '',
        });
      }
      if (!batch.has_more) break;
      starting_after = batch.data[batch.data.length - 1].id;
    }
    res.json({ orders: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/status', adminLimiter, adminAuth, async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!/^pi_[A-Za-z0-9]+$/.test(String(id))) return res.status(400).json({ error: 'bad id' });
    if (!['new', 'production', 'shipped'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const today = new Date().toISOString().slice(0, 10);
    const meta = status === 'new' ? { in_production: '', shipped: '' }
      : status === 'production' ? { in_production: today, shipped: '' }
      : { shipped: today };
    const pi = await stripe.paymentIntents.update(id, { metadata: meta });
    res.json({ ok: true, in_production: pi.metadata.in_production || '', shipped: pi.metadata.shipped || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Discount admin API (protected by ADMIN_KEY) ──────────────────────
app.get('/admin/api/discount', adminLimiter, adminAuth, (req, res) => res.json(DISCOUNT));

app.post('/admin/api/discount', adminLimiter, adminAuth, (req, res) => {
  const { mode } = req.body || {};
  if (!['off', 'percent', 'amount'].includes(mode)) return res.status(400).json({ error: 'mode must be off, percent, or amount' });
  let v = Number(req.body && req.body.value) || 0;
  if (v < 0) v = 0;
  if (mode === 'percent' && v > 90) v = 90;          // safety cap
  DISCOUNT = { mode, value: mode === 'off' ? 0 : v, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(DISCOUNT_FILE, JSON.stringify(DISCOUNT, null, 2));
  } catch (e) {
    return res.status(500).json({ error: 'Could not save discount: ' + e.message });
  }
  res.json(DISCOUNT);
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GBL Gifts running on port ${PORT}`));
