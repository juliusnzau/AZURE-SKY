import { q, tx } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { config } from '../config.js';
import { priceParts, normalizePhone } from '../lib/money.js';
import { notify, notifyAdmins, esc } from '../services/notify.js';
import { KES, markPaid, release, cancelUnpaid, simulateResult } from '../services/escrow.js';
import { post, ensureWallet } from '../services/ledger.js';
import * as mpesa from '../services/mpesa.js';
import * as airtel from '../services/airtel.js';

const bad = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });
const isId = (s) => /^[0-9a-f-]{36}$/.test(s || '');

function invoiceHtml(o, lines) {
  const rows = lines.map((l) => `<tr><td style="padding:6px 0">${esc(l.name)} × ${l.qty}</td><td align="right">${KES((l.unit_net_cents + l.tax_cents) * l.qty)}</td></tr>`).join('');
  return `<p>Invoice for order <b>#${o.number}</b></p><table width="100%" style="border-collapse:collapse;font-size:14px">${rows}
  <tr><td style="border-top:1px solid #cfe6fb;padding-top:8px">Subtotal (excl. VAT)</td><td align="right" style="border-top:1px solid #cfe6fb">${KES(o.subtotal_cents)}</td></tr>
  <tr><td>VAT</td><td align="right">${KES(o.tax_cents)}</td></tr><tr><td>Delivery</td><td align="right">${KES(o.delivery_fee_cents)}</td></tr>
  <tr><td><b>Total due</b></td><td align="right"><b>${KES(o.total_cents)}</b></td></tr></table>
  <p>Please pay in the next ${config.paymentTimeoutMin} minutes using M-Pesa, Airtel Money or your Azure Sky wallet. Your money is held safely until you confirm delivery.</p>`;
}

export default async function (app) {
  const buyer = { preHandler: requireRole('buyer') };
  const seller = { preHandler: requireRole('seller') };
  const anyone = { preHandler: authenticate };

  // ---- Checkout: one order per shop, stock reserved atomically ----
  app.post('/checkout', buyer, async (req, reply) => {
    const { address_id } = req.body || {};
    const created = await tx(async (c) => {
      const { rows: ad } = await c.query('SELECT * FROM addresses WHERE id=$1 AND user_id=$2', [isId(address_id) ? address_id : null, req.user.id]);
      if (!ad[0]) throw bad('Choose a delivery address.');
      const address = { recipient: ad[0].recipient, phone: ad[0].phone, county: ad[0].county, town: ad[0].town, street: ad[0].street, notes: ad[0].notes };
      const { rows: lines } = await c.query(
        `SELECT ci.quantity AS qty, i.*, s.seller_id FROM cart_items ci
         JOIN items i ON i.id=ci.item_id JOIN shops s ON s.id=i.shop_id AND s.active
         JOIN sellers se ON se.user_id=s.seller_id AND se.kyc='approved'
         WHERE ci.user_id=$1 AND i.active ORDER BY i.id FOR UPDATE OF i`, [req.user.id]);
      if (!lines.length) throw bad('Your cart is empty.');
      const byShop = new Map();
      for (const l of lines) { if (l.qty > l.quantity) throw bad(`Only ${l.quantity} of "${l.name}" left — update your cart.`); (byShop.get(l.shop_id) || byShop.set(l.shop_id, []).get(l.shop_id)).push(l); }
      const orders = [];
      for (const [shopId, ls] of byShop) {
        let net = 0; let tax = 0;
        const parts = ls.map((l) => { const p = priceParts(l); net += p.net * l.qty; tax += p.tax * l.qty; return { l, p }; });
        const total = net + tax + config.deliveryFeeCents;
        const o = (await c.query(
          `INSERT INTO orders(buyer_id,shop_id,seller_id,subtotal_cents,tax_cents,delivery_fee_cents,total_cents,address) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [req.user.id, shopId, ls[0].seller_id, net, tax, config.deliveryFeeCents, total, address])).rows[0];
        const olines = [];
        for (const { l, p } of parts) {
          const upd = await c.query('UPDATE items SET quantity=quantity-$2 WHERE id=$1 AND quantity>=$2', [l.id, l.qty]);
          if (!upd.rowCount) throw bad(`"${l.name}" just sold out.`, 409);
          await c.query('INSERT INTO order_items(order_id,item_id,name,unit_net_cents,tax,tax_cents,quantity) VALUES($1,$2,$3,$4,$5,$6,$7)', [o.id, l.id, l.name, p.net, l.tax, p.tax, l.qty]);
          olines.push({ name: l.name, qty: l.qty, unit_net_cents: p.net, tax_cents: p.tax });
        }
        const no = `#${o.number}`;
        await notify(req.user.id, { title: `Order ${no} placed — payment due`, body: `Total ${KES(total)}. Pay within ${config.paymentTimeoutMin} minutes to secure your items.`, emailBody: invoiceHtml(o, olines), link: `/orders/${o.id}`, orderId: o.id, db: c });
        await notify(ls[0].seller_id, { title: `New order ${no}`, body: `${olines.length} item line(s) worth ${KES(total)}. Waiting for the buyer's payment — you'll be told when it's paid.`, link: `/orders/${o.id}`, orderId: o.id, db: c });
        orders.push({ id: o.id, number: o.number, total_cents: total });
      }
      await c.query('DELETE FROM cart_items WHERE user_id=$1', [req.user.id]);
      return orders;
    });
    return reply.code(201).send({ orders: created });
  });

  // ---- Lists & detail ----
  app.get('/orders', anyone, async (req) => {
    const col = req.user.role === 'buyer' ? 'o.buyer_id' : req.user.role === 'seller' ? 'o.seller_id' : null;
    const { rows } = await q(
      `SELECT o.id,o.number,o.status,o.total_cents,o.created_at,s.name AS shop,
        (SELECT count(*)::int FROM order_items oi WHERE oi.order_id=o.id) AS lines
       FROM orders o JOIN shops s ON s.id=o.shop_id ${col ? `WHERE ${col}=$1` : "WHERE $1::text IS NOT NULL AND o.status='disputed'"}
       ORDER BY o.created_at DESC LIMIT 100`, [req.user.id]);
    return rows;
  });

  app.get('/orders/:id', anyone, async (req, reply) => {
    if (!isId(req.params.id)) return reply.code(404).send({ error: 'Order not found.' });
    const { rows } = await q(
      `SELECT o.*, s.name AS shop, bu.full_name AS buyer_name, se.business_name, su.phone AS seller_phone
       FROM orders o JOIN shops s ON s.id=o.shop_id JOIN users bu ON bu.id=o.buyer_id
       JOIN sellers se ON se.user_id=o.seller_id JOIN users su ON su.id=o.seller_id WHERE o.id=$1`, [req.params.id]);
    const o = rows[0];
    const me = req.user;
    if (!o || (me.role !== 'admin' && o.buyer_id !== me.id && o.seller_id !== me.id)) return reply.code(404).send({ error: 'Order not found.' });
    const items = (await q('SELECT name,quantity,unit_net_cents,tax,tax_cents FROM order_items WHERE order_id=$1', [o.id])).rows;
    const payments = (await q('SELECT provider,status,receipt,amount_cents,created_at FROM payments WHERE order_id=$1 ORDER BY created_at DESC', [o.id])).rows;
    const messages = (await q('SELECT id,sender_id,body,created_at FROM messages WHERE order_id=$1 AND (recipient_id=$2 OR sender_id=$2) ORDER BY id', [o.id, me.id])).rows;
    await q('UPDATE messages SET read_at=now() WHERE order_id=$1 AND recipient_id=$2 AND read_at IS NULL', [o.id, me.id]);
    // Sellers only see the buyer's delivery details once the order is paid (and not after cancellation).
    const showAddress = me.role !== 'seller' || ['paid_held', 'shipped', 'completed', 'disputed'].includes(o.status);
    return { ...o, address: showAddress ? o.address : null, items, payments, messages, me: me.id };
  });

  // ---- Pay: M-Pesa STK / Airtel push / wallet ----
  app.post('/orders/:id/pay', { ...buyer, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { method, phone } = req.body || {};
    const { rows } = await q("SELECT * FROM orders WHERE id=$1 AND buyer_id=$2 AND status='pending_payment'", [isId(req.params.id) ? req.params.id : null, req.user.id]);
    const o = rows[0];
    if (!o) return reply.code(404).send({ error: 'This order is not awaiting payment.' });
    if (method === 'wallet') {
      await tx(async (c) => {
        await ensureWallet(c, req.user.id);
        const u = await c.query('UPDATE wallets SET balance_cents=balance_cents-$2 WHERE user_id=$1 AND balance_cents>=$2', [req.user.id, o.total_cents]);
        if (!u.rowCount) throw bad('Your wallet balance is too low. Top up first or pay by M-Pesa / Airtel Money.');
        const paid = await markPaid(c, o.id, { provider: 'wallet', source: `wallet:${req.user.id}` });
        if (!paid) throw bad('This order is no longer awaiting payment.', 409);
        await c.query("INSERT INTO payments(order_id,provider,amount_cents,status) VALUES($1,'wallet',$2,'success')", [o.id, o.total_cents]);
      });
      return { ok: true, paid: true, message: 'Paid from your wallet.' };
    }
    if (!['mpesa', 'airtel'].includes(method)) throw bad('Choose M-Pesa, Airtel Money or wallet.');
    const msisdn = normalizePhone(phone);
    if (!msisdn) throw bad('Enter a valid phone number.');
    const svc = method === 'mpesa' ? mpesa.stkPush : airtel.collect;
    const { providerRef } = await svc({ phone: msisdn, amountCents: o.total_cents, reference: `AZ${o.number}`, description: `Order ${o.number}` });
    await q("UPDATE payments SET status='cancelled' WHERE order_id=$1 AND status='initiated'", [o.id]);
    await q('INSERT INTO payments(order_id,provider,phone,amount_cents,provider_ref) VALUES($1,$2,$3,$4,$5)', [o.id, method, msisdn, o.total_cents, providerRef]);
    simulateResult(method, providerRef);
    return { ok: true, paid: false, message: method === 'mpesa' ? 'Check your phone and enter your M-Pesa PIN.' : 'Approve the Airtel Money prompt on your phone.' };
  });

  app.post('/orders/:id/cancel', buyer, async (req, reply) => {
    const { rows } = await q("SELECT id FROM orders WHERE id=$1 AND buyer_id=$2 AND status='pending_payment'", [isId(req.params.id) ? req.params.id : null, req.user.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Only unpaid orders can be cancelled.' });
    await cancelUnpaid(rows[0].id, 'You cancelled this order.');
    return { ok: true };
  });

  // ---- Seller marks shipped ----
  app.post('/orders/:id/ship', seller, async (req, reply) => {
    const note = String(req.body?.tracking_note || '').slice(0, 300) || null;
    const { rows } = await q("UPDATE orders SET status='shipped', shipped_at=now(), tracking_note=$3 WHERE id=$1 AND seller_id=$2 AND status='paid_held' RETURNING *", [isId(req.params.id) ? req.params.id : null, req.user.id, note]);
    const o = rows[0];
    if (!o) return reply.code(404).send({ error: 'Only paid orders can be marked as shipped.' });
    await notify(o.buyer_id, { title: `Order #${o.number} is on its way`, body: `The seller has shipped your order${note ? ` (${note})` : ''}. When it arrives, confirm delivery so the seller gets paid.`, link: `/orders/${o.id}`, orderId: o.id });
    return { ok: true };
  });

  // ---- Buyer confirms delivery -> escrow release ----
  app.post('/orders/:id/confirm', buyer, async (req, reply) => {
    const { rows } = await q("SELECT id FROM orders WHERE id=$1 AND buyer_id=$2 AND status='shipped'", [isId(req.params.id) ? req.params.id : null, req.user.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'This order is not awaiting delivery confirmation.' });
    const done = await release(rows[0].id, { by: 'buyer' });
    if (!done) return reply.code(409).send({ error: 'This order was already processed.' });
    return { ok: true };
  });

  app.post('/orders/:id/dispute', buyer, async (req, reply) => {
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (reason.length < 5) throw bad('Tell us briefly what went wrong.');
    const { rows } = await q("UPDATE orders SET status='disputed' WHERE id=$1 AND buyer_id=$2 AND status='shipped' RETURNING *", [isId(req.params.id) ? req.params.id : null, req.user.id]);
    const o = rows[0];
    if (!o) return reply.code(404).send({ error: 'Only shipped orders can be disputed.' });
    await notify(o.seller_id, { title: `Order #${o.number} disputed`, body: `The buyer reported a problem: ${reason}. Our team will review. Funds stay in escrow meanwhile.`, link: `/orders/${o.id}`, orderId: o.id });
    await notifyAdmins({ title: `Dispute on order #${o.number}`, body: reason, link: '/admin' });
    return { ok: true };
  });
}
