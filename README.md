# ☁ Azure Sky

A multi-seller e-commerce marketplace built for Kenya: **M-Pesa** and **Airtel Money** payments, an **escrow (holding account)** flow, seller verification (KYC), buyer wallets, in-site messaging and email notifications — in a bright azure, cloudy interface.

## How a sale works

1. **Seller** registers with name/contacts, email, business registration certificate, KRA PIN, ID/passport, passport photo, logo (or the passport photo) and a mobile-money number or bank account. An admin verifies the documents; until then the seller can set up stock but items aren't public.
2. **Seller** builds **Shops › Categories › Brands › Items**, with photos, price, tax (VAT 16% / zero-rated / exempt / none, price inclusive or exclusive) and **quantity**. The stock view per shop is grouped Category › Brand › Item › Quantity.
3. **Buyer** registers (name, contacts, email, ID/passport, passport photo, mobile-money number or bank account), browses and searches every approved seller's items (name, description, category, brand, shop), fills a cart, saves delivery contacts/addresses, and has an **e-wallet** (top-up by M-Pesa/Airtel).
4. **Checkout** creates one order per shop and reserves stock. Buyer and seller are notified **on the site (notification + order message thread) and by email**; the buyer receives an itemised **invoice** and is prompted to pay.
5. **Payment** by M-Pesa STK push, Airtel Money push, or wallet. On success the money moves into the **escrow** account (double-entry ledger) and both parties are notified. Unpaid orders expire (default 30 min) and stock is released.
6. Seller **ships**; buyer **confirms delivery** (or it auto-confirms after 7 days; or the buyer opens a dispute for admin resolution).
7. On confirmation the escrow is released: **seller receives the total less 3% commission**, the commission is booked to the platform account, a payout is queued (M-Pesa B2C automatically; bank/Airtel via the admin console), and both parties get the completion notice by site + email.

## Technology (chosen for heavy traffic)

| Layer | Choice | Why |
|---|---|---|
| API | Node.js 20 + **Fastify** | One of the fastest Node frameworks; stateless, so you scale horizontally (`--scale api=N`) |
| Database | **PostgreSQL 16** | ACID transactions for money/stock; GIN full-text + trigram indexes for search; partial indexes for hot queries |
| Cache / rate limits / queues | **Redis** + **BullMQ** | Cache-aside for browse/search, shared rate limiting, durable background jobs |
| Workers | Separate `worker` process | Email, seller payouts, expiring unpaid orders, auto-release — never block web requests |
| Edge | **nginx** | Serves the static frontend and `/files` uploads directly, gzip, per-IP rate limits, load-balances API replicas |
| Frontend | Vanilla JS SPA (no build step) | Tiny, fast, zero toolchain; easy to host on a CDN |
| Files | Local volume behind a tiny adapter (`backend/src/lib/files.js`) | Swap for S3/MinIO + CDN for multi-host production |

Money is stored as **integer KES cents**; the ledger is **double-entry** (every transaction sums to zero), so escrow, wallets, seller balances and platform commission always reconcile.

## Run it locally (Docker)

```bash
cp .env.example .env          # defaults run fully in simulation mode (PAYMENTS_SIMULATE=true)
docker compose up --build
# open http://localhost:8080
```

* Admin login: the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (created on first boot — change it).
* In **simulation mode** STK/Airtel prompts "succeed" automatically after ~3.5 s and no real money or provider calls are made — ideal for trying the whole flow: register a seller → approve them in **Admin** → add items → register a buyer → order → pay → ship → confirm.
* Emails are logged to the worker console unless `SMTP_*` is set.

Without Docker: run PostgreSQL + Redis, `cd backend && npm install && npm start` (the API applies `db/schema.sql` on first boot and serves `../frontend`), and `npm run worker` in another terminal.

## Going live (checklist)

1. `NODE_ENV=production`, `PAYMENTS_SIMULATE=false`, strong `JWT_SECRET` and `CALLBACK_SECRET` (the server refuses to start otherwise), `PUBLIC_URL=https://your-domain` (must be public HTTPS for callbacks).
2. **M-Pesa (Safaricom Daraja):** create a Daraja app, get consumer key/secret, shortcode + passkey for STK Push; for seller payouts enable **B2C** and set `MPESA_INITIATOR_NAME` + `MPESA_SECURITY_CREDENTIAL` (the initiator password encrypted with Safaricom's certificate). Callback URLs are built automatically as `PUBLIC_URL/api/callbacks/<CALLBACK_SECRET>/mpesa/...`.
3. **Airtel Money:** get Open API client id/secret (collections). Disbursements need an RSA-encrypted PIN and an enabled product — see `services/airtel.js › disburse()`; until then Airtel/bank payouts appear in **Admin › Seller payouts** to settle manually and "Mark paid".
4. Restrict `/api/callbacks/` to Safaricom/Airtel IPs in `nginx/nginx.conf`, put TLS in front, use managed PostgreSQL (with PgBouncer) and managed Redis, move uploads to S3-compatible storage, set up SMTP (e.g. Amazon SES, Mailgun).
5. Legal/business: register for Daraja Go-Live, confirm VAT treatment and receipts with your accountant/KRA (eTIMS invoicing may apply to your marketplace), and publish Terms, Privacy Policy (Kenya Data Protection Act — you are storing IDs/KYC), and a refund policy.

## Project layout

```
backend/src/server.js          app bootstrap, plugins, admin bootstrap
backend/src/routes/            auth, catalog, seller, buyer, orders, messages, callbacks, admin
backend/src/services/          escrow (money movement), ledger, mpesa, airtel, notify, mailer
backend/src/workers/worker.js  email, payouts, expiry + auto-release
db/schema.sql                  full PostgreSQL schema
frontend/                      index.html, css/style.css, js/app.js
nginx/nginx.conf               edge config            docker-compose.yml   full stack
docs/                          ARCHITECTURE.md, API.md
```

## Honest status & known limitations

* This is a complete, working-by-design codebase, but it was **written without access to a live database, Safaricom or Airtel sandboxes**; it passes syntax and import checks and the money/VAT logic was unit-checked, but you should run the full flow in simulation mode, then in the Daraja/Airtel sandboxes, before real money. There is no automated test suite yet (CI only syntax-checks and applies the schema to a real PostgreSQL).
* Commission is 3% of the **order total** (goods + VAT + delivery). Change `commissionOf()` in `backend/src/lib/money.js` if you want a different base. Delivery is a flat fee per order (`DELIVERY_FEE_KES`).
* Emails are queued inside the same request as the DB transaction; a transactional outbox would make that fully atomic.
* No password-reset flow, 2FA, image resizing/CDN, product reviews, or shipping-carrier integration yet (see roadmap below).
* The SPA is client-rendered; if SEO for product pages matters, put a prerender layer or migrate the storefront to Next.js against the same API.

## Roadmap ideas
Password reset & 2FA · PesaLink bank payouts · eTIMS e-invoices · image thumbnails · reviews/ratings · seller analytics · courier integrations · Swahili translation · PostgreSQL read replicas / Meilisearch for very large catalogues.
