import { q } from '../lib/db.js';
import { requireRole, ownShop } from '../lib/auth.js';
import { readMultipart, saveFile, fileUrl } from '../lib/files.js';
import { slugify } from '../lib/money.js';
import { redis, bustItems } from '../lib/redis.js';

const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
const TAX = ['vat_16', 'zero_rated', 'exempt', 'none'];
const truthy = (v) => ['true', '1', true, 'on'].includes(v);

export default async function (app) {
  const guard = { preHandler: requireRole('seller') };

  // ---- Shops ----
  app.get('/seller/shops', guard, async (req) => (await q('SELECT * FROM shops WHERE seller_id=$1 ORDER BY created_at', [req.user.id])).rows);
  app.post('/seller/shops', guard, async (req, reply) => {
    const { name, description, county } = req.body || {};
    if (!name?.trim()) throw bad('Enter a shop name.');
    const { rows } = await q('INSERT INTO shops(seller_id,name,slug,description,county) VALUES($1,$2,$3,$4,$5) RETURNING *', [req.user.id, name.trim(), `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`, description || '', county || null]);
    return reply.code(201).send(rows[0]);
  });
  app.patch('/seller/shops/:shopId', guard, async (req, reply) => {
    const shop = await ownShop(req, reply, req.params.shopId); if (!shop) return;
    const b = req.body || {};
    const { rows } = await q('UPDATE shops SET name=COALESCE($2,name), description=COALESCE($3,description), county=COALESCE($4,county), active=COALESCE($5,active) WHERE id=$1 RETURNING *', [shop.id, b.name, b.description, b.county, b.active]);
    await bustItems();
    return rows[0];
  });

  // ---- Categories & brands (sellers can extend the shared catalogue) ----
  app.post('/seller/categories', guard, async (req, reply) => {
    const { name, parent_id } = req.body || {};
    if (!name?.trim()) throw bad('Enter a category name.');
    const { rows } = await q('INSERT INTO categories(name,slug,parent_id) VALUES($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING *', [name.trim(), slugify(name), parent_id || null]);
    await redis.del('cats').catch(() => {});
    return reply.code(201).send(rows[0]);
  });
  app.post('/seller/brands', guard, async (req, reply) => {
    const { name } = req.body || {};
    if (!name?.trim()) throw bad('Enter a brand name.');
    const { rows } = await q('INSERT INTO brands(name,slug) VALUES($1,$2) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING *', [name.trim(), slugify(name)]);
    await redis.del('brands').catch(() => {});
    return reply.code(201).send(rows[0]);
  });

  // ---- Items (multipart: fields + up to 6 photos) ----
  app.post('/seller/shops/:shopId/items', guard, async (req, reply) => {
    const shop = await ownShop(req, reply, req.params.shopId); if (!shop) return;
    const f = {}; const photos = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (!part.filename || photos.length >= 6) { part.file.resume(); continue; }
        photos.push(await saveFile(part, 'public', 'image'));
      } else f[part.fieldname] = part.value;
    }
    const item = await upsertItem(null, shop.id, f);
    for (const [i, key] of photos.entries()) await q('INSERT INTO item_photos(item_id,file_key,position) VALUES($1,$2,$3)', [item.id, key, i]);
    await bustItems();
    return reply.code(201).send(item);
  });
  app.patch('/seller/items/:id', guard, async (req, reply) => {
    const { rows } = await q('SELECT i.* FROM items i JOIN shops s ON s.id=i.shop_id WHERE i.id=$1 AND s.seller_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Item not found.' });
    const item = await upsertItem(rows[0], rows[0].shop_id, req.body || {});
    await bustItems();
    return item;
  });
  // Quantities: absolute set or relative delta
  app.post('/seller/items/:id/stock', guard, async (req, reply) => {
    const { set, delta } = req.body || {};
    const { rows } = await q(
      `UPDATE items i SET quantity = CASE WHEN $3::int IS NOT NULL THEN $3::int ELSE i.quantity + COALESCE($4::int,0) END
       FROM shops s WHERE i.id=$1 AND s.id=i.shop_id AND s.seller_id=$2
         AND (CASE WHEN $3::int IS NOT NULL THEN $3::int ELSE i.quantity + COALESCE($4::int,0) END) >= 0
       RETURNING i.id,i.quantity`, [req.params.id, req.user.id, set ?? null, delta ?? null]);
    if (!rows[0]) return reply.code(400).send({ error: 'Quantity cannot go below zero (or item not found).' });
    await bustItems();
    return rows[0];
  });
  app.post('/seller/items/:id/photos', guard, async (req, reply) => {
    const { rows } = await q('SELECT i.id FROM items i JOIN shops s ON s.id=i.shop_id WHERE i.id=$1 AND s.seller_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Item not found.' });
    const { files } = await readMultipart(req, { photo: { scope: 'public', kind: 'image' } });
    if (!files.photo) throw bad('Choose a photo to upload.');
    await q('INSERT INTO item_photos(item_id,file_key,position) VALUES($1,$2,(SELECT COALESCE(max(position)+1,0) FROM item_photos WHERE item_id=$1))', [rows[0].id, files.photo]);
    await bustItems();
    return { url: fileUrl(files.photo) };
  });
  app.delete('/seller/items/:id', guard, async (req, reply) => {
    const { rowCount } = await q('UPDATE items i SET active=false FROM shops s WHERE i.id=$1 AND s.id=i.shop_id AND s.seller_id=$2', [req.params.id, req.user.id]);
    if (!rowCount) return reply.code(404).send({ error: 'Item not found.' });
    await bustItems();
    return { ok: true };
  });

  // ---- Per-shop stock view: Categories > Brands > Items > Quantities ----
  app.get('/seller/shops/:shopId/stock', guard, async (req, reply) => {
    const shop = await ownShop(req, reply, req.params.shopId); if (!shop) return;
    const { rows } = await q(
      `SELECT i.id,i.name,i.sku,i.price_cents,i.tax,i.tax_inclusive,i.quantity,c.id AS category_id,c.name AS category,COALESCE(b.name,'No brand') AS brand,
        (SELECT file_key FROM item_photos p WHERE p.item_id=i.id ORDER BY position LIMIT 1) AS photo
       FROM items i JOIN categories c ON c.id=i.category_id LEFT JOIN brands b ON b.id=i.brand_id
       WHERE i.shop_id=$1 AND i.active ORDER BY c.name,b.name NULLS LAST,i.name`, [shop.id]);
    const cats = new Map(); let units = 0;
    for (const r of rows) {
      if (!cats.has(r.category)) cats.set(r.category, { category: r.category, category_id: r.category_id, total_units: 0, brands: new Map() });
      const c = cats.get(r.category);
      if (!c.brands.has(r.brand)) c.brands.set(r.brand, { brand: r.brand, total_units: 0, items: [] });
      const b = c.brands.get(r.brand);
      b.items.push({ id: r.id, name: r.name, sku: r.sku, price_cents: r.price_cents, tax: r.tax, tax_inclusive: r.tax_inclusive, quantity: r.quantity, photo: fileUrl(r.photo) });
      b.total_units += r.quantity; c.total_units += r.quantity; units += r.quantity;
    }
    return { shop: { id: shop.id, name: shop.name }, total_units: units, categories: [...cats.values()].map((c) => ({ ...c, brands: [...c.brands.values()] })) };
  });

  app.get('/seller/summary', guard, async (req) => (await q(
    `SELECT count(*) FILTER (WHERE status='paid_held')::int AS to_ship,
            count(*) FILTER (WHERE status='shipped')::int AS in_transit,
            COALESCE(sum(seller_net_cents) FILTER (WHERE status IN ('paid_held','shipped')),0) AS held_cents,
            COALESCE(sum(seller_net_cents) FILTER (WHERE status='completed'),0) AS earned_cents
     FROM orders WHERE seller_id=$1`, [req.user.id])).rows[0]);
}

async function upsertItem(existing, shopId, f) {
  const name = (f.name ?? existing?.name ?? '').trim();
  if (!name) throw bad('Enter an item name.');
  const category_id = Number(f.category_id ?? existing?.category_id);
  if (!category_id) throw bad('Choose a category.');
  const priceKes = f.price !== undefined ? Number(f.price) : existing ? existing.price_cents / 100 : NaN;
  if (!(priceKes >= 0)) throw bad('Enter a valid price in KES.');
  const tax = f.tax ?? existing?.tax ?? 'vat_16';
  if (!TAX.includes(tax)) throw bad('Choose a valid tax type.');
  const qty = f.quantity !== undefined ? parseInt(f.quantity, 10) : existing?.quantity ?? 0;
  if (!(qty >= 0)) throw bad('Quantity must be zero or more.');
  const vals = [name, f.description ?? existing?.description ?? '', f.sku || existing?.sku || null, category_id,
    f.brand_id !== undefined ? (f.brand_id ? Number(f.brand_id) : null) : existing?.brand_id ?? null,
    Math.round(priceKes * 100), tax, f.tax_inclusive !== undefined ? truthy(f.tax_inclusive) : existing?.tax_inclusive ?? true, qty,
    f.active !== undefined ? truthy(f.active) : existing?.active ?? true];
  try {
    const sql = existing
      ? 'UPDATE items SET name=$1,description=$2,sku=$3,category_id=$4,brand_id=$5,price_cents=$6,tax=$7,tax_inclusive=$8,quantity=$9,active=$10 WHERE id=$11 RETURNING *'
      : 'INSERT INTO items(name,description,sku,category_id,brand_id,price_cents,tax,tax_inclusive,quantity,active,shop_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *';
    return (await q(sql, [...vals, existing ? existing.id : shopId])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw bad('This SKU is already used in your shop.');
    if (e.code === '23503') throw bad('That category or brand does not exist.');
    throw e;
  }
}
