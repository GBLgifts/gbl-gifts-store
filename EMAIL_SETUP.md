# GBL Gifts — email capture, welcome code & abandoned-cart recovery

Added Oct 6, 2026. Everything lives in `server.js` + `gbl-gifts-website.html`; no new npm packages.

## What's live as soon as this deploys (no setup needed)
- **Welcome popup** on the storefront (8 s after landing, or on exit-intent on desktop). Once per visitor;
  dismissed → asks again after 14 days; never shown on `?products=` / `?coupon=` links.
- **Code `WELCOME10` = 10 % off** — works alongside the admin coupon (THANKS2YOU). Change with Railway
  variables `WELCOME_CODE` / `WELCOME_PCT` (the popup wording says "10%" — edit the HTML if you change the percent).
- Sign-ups are saved as **Stripe Customers** (Stripe dashboard → Customers; metadata `signup=popup`).
  `GET /admin/api/subscribers?key=ADMIN_KEY` lists them as JSON.
- Carts are snapshotted to the Stripe Customer once an email is known (popup sign-up or a checkout attempt).

## Turn on the emails (one-time, ~10 minutes)
1. Create a free account at https://resend.com (3,000 emails/month free).
2. Resend → **Domains → Add domain → `gblgifts.com`**. Add the DNS records it shows (DKIM TXT, SPF/MX for the
   `send` subdomain) at your domain registrar. Wait for "Verified".
3. Resend → **API Keys → Create** (Sending access only). Copy the key.
4. Railway → the gbl-gifts-store service → **Variables → New variable**:
   - `RESEND_API_KEY` = the key from step 3
   - (optional) `EMAIL_FROM` = `GBL Gifts <office@gblgifts.com>`  ← default
   - (optional) `CART_RECOVERY_HOURS` = `2`  ← default
   - (optional) `EMAIL_SECRET` = any long random string (signs unsubscribe links; defaults to ADMIN_KEY)
5. Railway redeploys automatically when variables change. Check the deploy logs for `[email sent] welcome → …`.

Until `RESEND_API_KEY` exists the server logs `[email skipped — no RESEND_API_KEY]` and does nothing else
differently — the popup, the code and the subscriber list all still work.

## How recovery works
- Every 15 min the server looks for Stripe Customers with `cart_state=open` whose cart is older than
  `CART_RECOVERY_HOURS`, confirms no succeeded PaymentIntent for that email since the snapshot, then sends
  ONE "You left something behind" email with a link that rebuilds the cart (`/?products=SKU:QTY,…&coupon=WELCOME10`).
- Max one recovery email per shopper per 7 days. Orders (webhook `payment_intent.succeeded`, or the cart
  emptying on the storefront) close the snapshot. Every email has a signed one-click unsubscribe link.

## Endpoints added
`POST /api/subscribe` · `POST /api/cart` · `GET /unsubscribe` · `GET /admin/api/subscribers` (ADMIN_KEY)
