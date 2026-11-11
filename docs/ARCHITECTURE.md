# Architecture

```
 Browser (SPA) ──► nginx ──► API (Fastify, N replicas) ──► PostgreSQL
                     │            │  └──► Redis (cache, rate limits, BullMQ)
                     │            └──► M-Pesa Daraja / Airtel Open API (STK push, B2C)
                     └──► /files (uploads)          Worker ──► SMTP, payouts, expiry, auto-release
 Safaricom / Airtel ──► /api/callbacks/<secret>/… ──► escrow.settleProviderResult()
```

## Money flow (double-entry ledger, KES cents)

| Event | Entries (sum = 0) |
|---|---|
| Buyer pays by M-Pesa/Airtel | `ext:mpesa −T`, `escrow +T` |
| Buyer pays from wallet | `wallet:<buyer> −T`, `escrow +T` |
| Wallet top-up | `ext:mpesa −A`, `wallet:<buyer> +A` |
| Delivery confirmed | `escrow −T`, `seller:<id> +(T−C)`, `platform +C` (C = 3% of T) |
| Seller payout sent | `seller:<id> −(T−C)`, `ext:payout +(T−C)` |
| Refund (dispute) | `escrow −T`, `wallet:<buyer> +T` |

Escrow balance = money held for undelivered orders. `platform` balance = commission earned (shown in the Admin console); transferring it to your company bank account is a normal treasury settlement from your Daraja shortcode.

## Order states
`pending_payment → paid_held → shipped → completed`; side exits: `cancelled` (unpaid/expired), `disputed → completed | refunded`.

## Concurrency & integrity
* Stock is reserved at checkout with `UPDATE … WHERE quantity >= n` inside a transaction (no overselling) and restored on cancel/refund.
* Provider callbacks and the simulator are **idempotent**: a payment/top-up row only leaves `initiated` once (`FOR UPDATE` + status guard).
* Orders/escrow transitions lock the order row (`FOR UPDATE`), so double-clicks and retries cannot pay a seller twice (`payouts.order_id` is also unique).

## Scaling notes
* API and workers are stateless — add replicas. Browse/search responses are cached in Redis for 20–45 s; cache is invalidated on seller edits.
* Search uses `tsvector` (GIN) + `pg_trgm` for typo-tolerant name matching. At very large scale move to Meilisearch/OpenSearch fed from the same table.
* Put PgBouncer in front of PostgreSQL, add read replicas for catalogue queries, serve `/files` from a CDN.

## Security notes
* JWT auth (7 days), bcrypt password hashing, per-route rate limits (login/register/payments) plus global limits shared via Redis.
* KYC documents are stored in a **private** folder and only streamed to admins (each view is audit-logged). Item photos and logos are public.
* Callback URLs carry a secret path segment; restrict by IP at nginx as well.
* Sellers only see a buyer's delivery details after payment is held.
