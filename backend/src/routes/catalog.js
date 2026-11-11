import { q } from '../lib/db.js';
import { cached } from '../lib/redis.js';
import { fileUrl } from '../lib/files.js';
import { priceParts } from '../lib/money.js';

export const shapeItem = (r) => {
  const p = priceParts(r);
  return {
    id: r.id, name: r.name, description: r.description, sku: r.sku,
    price_cents: p.net + p.tax, net_cents: p.net, tax_cents: p.tax, tax: r.tax, tax_inclusive: r.tax_inclusive,
    quantity: r.quantity, in_stock: r.quantity > 0,
    category: r.category_name, category_id: r.category_id, brand: r.brand_name, brand_id: r.brand_id,
    shop: { id: r.shop_id, name: r.shop_name, slug: r.shop_slug },
    photos: (r.photos || []).map(fileUrl).filter(Boolean),
  };
};
const ITEM_SELECT = `
  SELECT i.*, c.name AS category_name, b.name AS brand_name, s.name AS shop_name, s.slug AS shop_slug,
    COALESCE((SELECT array_agg(file_key ORDER BY position) FROM item_photos p WHERE p.item_id=i.id), '{}') AS photos
  FROM items i
  JOIN shops s ON s.id=i.shop_id AND s.active
  JOIN sellers se ON se.user_id=s.seller_id AND se.kyc='approved'
  JOIN categories c ON c.id=i.category_id
  LEFT JOIN brands b ON b.id=i.brand_id`;

export default async function (app) {
  app.get('/categories', async () => cached('cats', 300, async () => (await q('SELECT id,parent_id,name,slug FROM categories ORDER BY name')).rows));
  app.get('/brands', async () => cached('brands', 300, async () => (await q('SELECT id,name,slug FROM brands ORDER BY name')).rows));

  // Browse + search by name, description, category, brand or shop. Short-TTL Redis cache absorbs traffic bursts.
  app.get('/items', async (req) => {
    const { q: term, category, brand, shop, min, max, sort = 'new', in_stock } = req.query;
    const page = Math.min(Math.max(parseInt(req.query.page || '1', 10) || 1, 1), 200);
    const size = Math.min(parseInt(req.query.size || '24', 10) || 24, 60);
    const key = `items:${JSON.stringify([term, category, brand, shop, min, max, sort, in_stock, page, size])}`;
    return cached(key, term ? 20 : 45, async () => {
      const w = ['i.active']; const p = [];
      const add = (v) => { p.push(v); return `$${p.length}`; };
      let rank = '0';
      if (term?.trim()) {
        const t = term.trim().slice(0, 80);
        const a = add(t); const l = add(`%${t.replace(/[%_\\]/g, '')}%`);
        w.push(`(i.search @@ websearch_to_tsquery('simple', ${a}) OR i.name ILIKE ${l} OR i.description ILIKE ${l} OR c.name ILIKE ${l} OR b.name ILIKE ${l} OR s.name ILIKE ${l} OR i.name % ${a})`);
        rank = `ts_rank(i.search, websearch_to_tsquery('simple', ${a})) + similarity(i.name, ${a})`;
      }
      if (category) { const n = add(Number(category)); w.push(`(i.category_id = ${n} OR c.parent_id = ${n})`); }
      if (brand) w.push(`i.brand_id = ${add(Number(brand))}`);
      if (shop) { const n = add(String(shop)); w.push(`(s.id::text = ${n} OR s.slug = ${n})`); }
      if (min) w.push(`i.price_cents >= ${add(Math.round(Number(min) * 100))}`);
      if (max) w.push(`i.price_cents <= ${add(Math.round(Number(max) * 100))}`);
      if (in_stock === '1') w.push('i.quantity > 0');
      const order = { new: 'i.created_at DESC', price_asc: 'i.price_cents ASC', price_desc: 'i.price_cents DESC', relevance: `${rank} DESC, i.created_at DESC` }[sort] || 'i.created_at DESC';
      p.push(size, (page - 1) * size);
      const { rows } = await q(`${ITEM_SELECT} WHERE ${w.join(' AND ')} ORDER BY ${order} LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
      return { page, size, items: rows.map(shapeItem) };
    });
  });

  app.get('/items/:id', async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(404).send({ error: 'Item not found.' });
    const { rows } = await q(`${ITEM_SELECT} WHERE i.id=$1 AND i.active`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Item not found.' });
    return shapeItem(rows[0]);
  });

  app.get('/shops/:slug', async (req, reply) => {
    const { rows } = await q(`SELECT s.id,s.name,s.slug,s.description,s.county,se.logo FROM shops s JOIN sellers se ON se.user_id=s.seller_id AND se.kyc='approved' WHERE s.active AND (s.slug=$1 OR s.id::text=$1)`, [req.params.slug]);
    if (!rows[0]) return reply.code(404).send({ error: 'Shop not found.' });
    return { ...rows[0], logo: undefined, logo_url: fileUrl(rows[0].logo) };
  });
}
