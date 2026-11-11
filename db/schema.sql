-- Azure Sky — PostgreSQL schema. All money is stored as integer KES cents (1 KES = 100).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role AS ENUM ('buyer','seller','admin');
CREATE TYPE user_status AS ENUM ('active','suspended');
CREATE TYPE kyc_status AS ENUM ('pending','approved','rejected');
CREATE TYPE tax_type AS ENUM ('vat_16','zero_rated','exempt','none');
CREATE TYPE order_status AS ENUM ('pending_payment','paid_held','shipped','completed','cancelled','disputed','refunded');
CREATE TYPE pay_status AS ENUM ('initiated','success','failed','cancelled');
CREATE TYPE payout_status AS ENUM ('queued','processing','paid','failed');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL,
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  id_type TEXT NOT NULL CHECK (id_type IN ('national_id','passport')),
  id_number TEXT NOT NULL,
  passport_photo TEXT NOT NULL,
  status user_status NOT NULL DEFAULT 'active',
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_idnum_role ON users (id_type, id_number, role);

CREATE TABLE payment_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mpesa','airtel','bank')),
  phone TEXT, bank_name TEXT, account_number TEXT, account_name TEXT,
  is_default BOOLEAN NOT NULL DEFAULT true,
  CHECK ((kind IN ('mpesa','airtel') AND phone IS NOT NULL) OR (kind='bank' AND account_number IS NOT NULL AND bank_name IS NOT NULL))
);
CREATE INDEX ON payment_accounts(user_id);

CREATE TABLE sellers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  registration_no TEXT NOT NULL,
  registration_cert TEXT NOT NULL,
  kra_pin TEXT NOT NULL CHECK (kra_pin ~ '^[AP][0-9]{9}[A-Z]$'),
  logo TEXT NOT NULL,
  kyc kyc_status NOT NULL DEFAULT 'pending',
  kyc_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  county TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON shops(seller_id);

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  parent_id INT REFERENCES categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);
CREATE TABLE brands (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  category_id INT NOT NULL REFERENCES categories(id),
  brand_id INT REFERENCES brands(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sku TEXT,
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  tax tax_type NOT NULL DEFAULT 'vat_16',
  tax_inclusive BOOLEAN NOT NULL DEFAULT true,
  quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  search TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description,'')), 'C')) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_id, sku)
);
CREATE INDEX items_search_gin ON items USING GIN (search);
CREATE INDEX items_name_trgm ON items USING GIN (name gin_trgm_ops);
CREATE INDEX items_browse ON items (category_id, created_at DESC) WHERE active;
CREATE INDEX items_shop ON items (shop_id, category_id, brand_id);

CREATE TABLE item_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0
);
CREATE INDEX ON item_photos(item_id, position);

CREATE TABLE addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT, recipient TEXT NOT NULL, phone TEXT NOT NULL,
  county TEXT NOT NULL, town TEXT NOT NULL, street TEXT NOT NULL, notes TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ON addresses(user_id);

CREATE TABLE cart_items (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity INT NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (user_id, item_id)
);

-- One order per shop; a checkout with items from 3 shops creates 3 orders.
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  buyer_id UUID NOT NULL REFERENCES users(id),
  shop_id UUID NOT NULL REFERENCES shops(id),
  seller_id UUID NOT NULL REFERENCES sellers(user_id),
  status order_status NOT NULL DEFAULT 'pending_payment',
  subtotal_cents BIGINT NOT NULL,
  tax_cents BIGINT NOT NULL,
  delivery_fee_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL,
  commission_cents BIGINT NOT NULL DEFAULT 0,
  seller_net_cents BIGINT NOT NULL DEFAULT 0,
  address JSONB NOT NULL,
  tracking_note TEXT,
  paid_at TIMESTAMPTZ, shipped_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON orders(buyer_id, created_at DESC);
CREATE INDEX ON orders(seller_id, created_at DESC);
CREATE INDEX orders_pending ON orders(created_at) WHERE status='pending_payment';
CREATE INDEX orders_shipped ON orders(shipped_at) WHERE status='shipped';

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  name TEXT NOT NULL, unit_net_cents BIGINT NOT NULL, tax tax_type NOT NULL,
  tax_cents BIGINT NOT NULL, quantity INT NOT NULL CHECK (quantity > 0)
);
CREATE INDEX ON order_items(order_id);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL CHECK (provider IN ('mpesa','airtel','wallet')),
  phone TEXT, amount_cents BIGINT NOT NULL,
  status pay_status NOT NULL DEFAULT 'initiated',
  provider_ref TEXT,
  receipt TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_ref ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX ON payments(order_id);

CREATE TABLE wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0)
);
CREATE TABLE topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL, phone TEXT NOT NULL, amount_cents BIGINT NOT NULL,
  status pay_status NOT NULL DEFAULT 'initiated',
  provider_ref TEXT, receipt TEXT, raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX topups_provider_ref ON topups(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Double-entry ledger: every txn_id sums to zero.
-- Accounts: ext:<provider>, wallet:<uid>, escrow, seller:<uid>, platform, ext:payout
CREATE TABLE ledger (
  id BIGSERIAL PRIMARY KEY,
  txn_id UUID NOT NULL,
  account TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  order_id UUID REFERENCES orders(id),
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger(txn_id);
CREATE INDEX ON ledger(account);
CREATE INDEX ON ledger(order_id);

CREATE TABLE payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  seller_id UUID NOT NULL REFERENCES sellers(user_id),
  amount_cents BIGINT NOT NULL,
  method TEXT NOT NULL, destination TEXT NOT NULL,
  status payout_status NOT NULL DEFAULT 'queued',
  provider_ref TEXT, error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON payouts(status);

CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id),
  recipient_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON messages(recipient_id, read_at, created_at DESC);
CREATE INDEX ON messages(order_id, created_at);

CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY, actor UUID, action TEXT NOT NULL, detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO categories(name,slug) VALUES
 ('Electronics','electronics'),('Fashion','fashion'),('Home & Living','home-living'),
 ('Groceries','groceries'),('Beauty & Health','beauty-health'),('Agriculture','agriculture'),
 ('Phones & Tablets','phones-tablets'),('Books & Stationery','books-stationery');
