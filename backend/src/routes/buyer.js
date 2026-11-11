import { q, tx } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';
import { config } from '../config.js';
import { normalizePhone, priceParts } from '../lib/money.js';
import { fileUrl } from '../lib/files.js';
import * as mpesa from '../services/mpesa.js';
import * as airtel from '../services/airtel.js';
import { simulateResult } from '../services/escrow.js';

const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
const isId = (s) => /^[0-9a-f-]{36}$/.test(s || '');

export async function loadCart(userId) {
  const { rows } = await q(
    `SELECT ci.quantity AS qty, i.*, s.name AS shop_name, s.id AS sid,
      (SELECT file_key FROM item_photos p WHERE p.item_id=i.id ORDER BY position LIMIT 1) AS photo
     FROM cart_items ci JOIN items i ON i.id=ci.item_id AND i.active
     JOIN shops s ON s.id=i.shop_id AND s.active
     JOIN sellers se ON se.user_id=s.seller_id AND se.kyc='approved'
     WHERE ci.user_id=$1 ORDER BY s.name, i.name`, [userId]);
  const groups = new Map(); let total = 0;
  for (const r of rows) {
    const p = priceParts(r);
    const g = groups.get(r.sid) || { shop_id: r.sid, shop: r.shop_name, lines: [], net: 0, tax: 0, delivery: config.deliveryFeeCents, total: 0 };
    g.lines.push({ item_id: r.id, name: r.name, photo: fileUrl(r.photo), unit_cents: p.net + p.tax, qty: r.qty, available: r.quantity });
    g.net += p.net * r.qty; g.tax += p.tax * r.qty;
    groups.set(r.sid, g);
  }
  for (const g of groups.values()) { g.total = g.net + g.tax + g.delivery; total += g.total; }
  return { groups: [...groups.values()], total_cents: total };
}

export default async function (app) {
  const guard = { preHandler: requireRole('buyer') };

  // ---- Delivery contacts & addresses ----
  app.get('/addresses', guard, async (req) => (await q('SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC, id', [req.user.id])).rows);
  app.post('/addresses', guard, async (req, reply) => {
    const b = req.body || {};
    const phone = normalizePhone(b.phone);
    if (!b.recipient?.trim() || !phone || !b.county?.trim() || !b.town?.trim() || !b.street?.trim()) throw bad('Enter recipient, a valid phone, county, town and street/landmark.');
    const row = await tx(async (c) => {
      const { rows: ex } = await c.query('SELECT count(*)::int n FROM addresses WHERE user_id=$1', [req.user.id]);
      const def = !!b.is_default || ex[0].n === 0;
      if (def) await c.query('UPDATE addresses SET is_default=false WHERE user_id=$1', [req.user.id]);
      return (await c.query('INSERT INTO addresses(user_id,label,recipient,phone,county,town,street,notes,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.user.id, b.label || null, b.recipient.trim(), phone, b.county.trim(), b.town.trim(), b.street.trim(), b.notes || null, def])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.delete('/addresses/:id', guard, async (req) => { if (isId(req.params.id)) await q('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); return { ok: true }; });

  app.get('/payment-account', guard, async (req) => (await q('SELECT kind,phone,bank_name,account_number,account_name FROM payment_accounts WHERE user_id=$1 ORDER BY is_default DESC LIMIT 1', [req.user.id])).rows[0] || null);

  // ---- Cart ----
  app.get('/cart', guard, (req) => loadCart(req.user.id));
  app.put('/cart/:itemId', guard, async (req, reply) => {
    const qty = parseInt(req.body?.quantity, 10);
    if (!isId(req.params.itemId) || !(qty >= 0)) throw bad('Invalid quantity.');
    if (qty === 0) await q('DELETE FROM cart_items WHERE user_id=$1 AND item_id=$2', [req.user.id, req.params.itemId]);
    else {
      const { rows } = await q('SELECT quantity FROM items WHERE id=$1 AND active', [req.params.itemId]);
      if (!rows[0]) return reply.code(404).send({ error: 'Item not found.' });
      if (qty > rows[0].quantity) throw bad(`Only ${rows[0].quantity} available.`);
      await q('INSERT INTO cart_items(user_id,item_id,quantity) VALUES($1,$2,$3) ON CONFLICT (user_id,item_id) DO UPDATE SET quantity=$3', [req.user.id, req.params.itemId, qty]);
    }
    return { ok: true };
  });

  // ---- E-wallet ----
  app.get('/wallet', guard, async (req) => {
    const bal = (await q('SELECT balance_cents FROM wallets WHERE user_id=$1', [req.user.id])).rows[0]?.balance_cents ?? 0;
    const topups = (await q('SELECT id,provider,amount_cents,status,receipt,created_at FROM topups WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [req.user.id])).rows;
    const movements = (await q('SELECT created_at,amount_cents,memo FROM ledger WHERE account=$1 ORDER BY id DESC LIMIT 30', [`wallet:${req.user.id}`])).rows;
    return { balance_cents: bal, topups, movements };
  });
  app.post('/wallet/topup', { ...guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { provider, phone, amount } = req.body || {};
    const msisdn = normalizePhone(phone);
    const cents = Math.round(Number(amount) * 100);
    if (!['mpesa', 'airtel'].includes(provider)) throw bad('Choose M-Pesa or Airtel Money.');
    if (!msisdn) throw bad('Enter a valid phone number.');
    if (!(cents >= 1000 && cents <= 15000000)) throw bad('Top up between KES 10 and KES 150,000.');
    const { providerRef } = await (provider === 'mpesa' ? mpesa.stkPush : airtel.collect)({ phone: msisdn, amountCents: cents, reference: 'WALLET', description: 'Wallet' });
    await q('INSERT INTO topups(user_id,provider,phone,amount_cents,provider_ref) VALUES($1,$2,$3,$4,$5)', [req.user.id, provider, msisdn, cents, providerRef]);
    simulateResult(provider, providerRef);
    return { ok: true, message: provider === 'mpesa' ? 'Check your phone and enter your M-Pesa PIN.' : 'Approve the Airtel Money prompt on your phone.' };
  });
}
