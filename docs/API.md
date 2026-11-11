# API summary (all under `/api`, JSON; uploads are `multipart/form-data`)

**Auth** — `POST /auth/register/buyer` · `POST /auth/register/seller` · `POST /auth/login` · `GET /auth/verify/:token` · `GET /me`

**Catalogue (public)** — `GET /categories` · `GET /brands` · `GET /items?q=&category=&brand=&shop=&min=&max=&sort=new|price_asc|price_desc|relevance&in_stock=1&page=` · `GET /items/:id` · `GET /shops/:slug`

**Seller** — `GET|POST /seller/shops` · `PATCH /seller/shops/:id` · `POST /seller/categories` · `POST /seller/brands` · `POST /seller/shops/:id/items` · `PATCH|DELETE /seller/items/:id` · `POST /seller/items/:id/stock {set|delta}` · `POST /seller/items/:id/photos` · `GET /seller/shops/:id/stock` · `GET /seller/summary`

**Buyer** — `GET|POST /addresses` · `DELETE /addresses/:id` · `GET /cart` · `PUT /cart/:itemId {quantity}` · `GET /wallet` · `POST /wallet/topup {provider,phone,amount}` · `GET /payment-account`

**Orders** — `POST /checkout {address_id}` · `GET /orders` · `GET /orders/:id` · `POST /orders/:id/pay {method: mpesa|airtel|wallet, phone}` · `POST /orders/:id/cancel` · `POST /orders/:id/ship {tracking_note}` · `POST /orders/:id/confirm` · `POST /orders/:id/dispute {reason}`

**Messaging** — `GET /notifications` · `POST /notifications/read` · `GET /messages` · `POST /orders/:id/messages {body}`

**Admin** — `GET /admin/stats` · `GET /admin/sellers?status=` · `GET /admin/docs/:userId/(passport|cert)` · `POST /admin/sellers/:id/(approve|reject)` · `GET /admin/payouts` · `POST /admin/payouts/:id/(mark-paid|retry)` · `POST /admin/orders/:id/resolve {action: release|refund}`

**Webhooks** — `POST /callbacks/:secret/mpesa/stk` · `…/mpesa/b2c/result` · `…/mpesa/b2c/timeout` · `…/airtel/collect`
