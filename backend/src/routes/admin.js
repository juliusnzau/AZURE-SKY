import { createReadStream, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { q, tx } from '../lib/db.js';
import { requireRole } from '../lib/auth.js';
import { privatePath, fileUrl } from '../lib/files.js';
import { release, refundToWallet, markPayoutPaid } from '../services/escrow.js';
import { notify } from '../services/notify.js';
import { payoutQueue } from '../lib/queue.js';
import { bustItems } from '../lib/redis.js';

const isId = (s) => /^[0-9a-f-]{36}$/.test(s || '');
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export default async function (app) {
  const g = { preHandler: requireRole('admin') };
  const audit = (actor, action, detail) => q('INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)', [actor, action, detail]);

  app.get('/admin/stats', g, async () => {
    const bal = Object.fromEntries((await q("SELECT account, sum(amount_cents)::bigint AS bal FROM ledger WHERE account IN ('escrow','platform','ext:payout') GROUP BY account")).rows.map((r) => [r.account, r.bal]));
    const c = (await q(`SELECT (SELECT count(*) FROM users WHERE role='buyer')::int buyers,(SELECT count(*) FROM sellers)::int sellers,
      (SELECT count(*) FROM sellers WHERE kyc='pending')::int pending_sellers,(SELECT count(*) FROM orders)::int orders,
      (SELECT count(*) FROM orders WHERE status='disputed')::int disputes,(SELECT count(*) FROM payouts WHERE status IN ('queued','failed'))::int open_payouts`)).rows[0];
    return { ...c, escrow_cents: bal.escrow || 0, commission_cents: bal.platform || 0 };
  });

  // ---- Seller KYC ----
  app.get('/admin/sellers', g, async (req) => (await q(
    `SELECT u.id,u.full_name,u.email,u.phone,u.id_type,u.id_number,u.email_verified,s.business_name,s.registration_no,s.kra_pin,s.kyc,s.kyc_note,s.logo,
       (SELECT row_to_json(a) FROM (SELECT kind,phone,bank_name,account_number FROM payment_accounts WHERE user_id=u.id LIMIT 1) a) AS payout_account
     FROM sellers s JOIN users u ON u.id=s.user_id WHERE ($1::text IS NULL OR s.kyc::text=$1) ORDER BY s.created_at DESC LIMIT 100`, [req.query.status || null])).rows.map((r) => ({ ...r, logo_url: fileUrl(r.logo), logo: undefined })));

  // Private KYC documents (passport photo / registration certificate) — admin only
  app.get('/admin/docs/:userId/:which', g, async (req, reply) => {
    if (!isId(req.params.userId)) return reply.code(404).send({ error: 'Not found' });
    const col = { passport: 'u.passport_photo', cert: 's.registration_cert' }[req.params.which];
    if (!col) return reply.code(404).send({ error: 'Not found' });
    const { rows } = await q(`SELECT ${col} AS k FROM users u LEFT JOIN sellers s ON s.user_id=u.id WHERE u.id=$1`, [req.params.userId]);
    const key = rows[0]?.k;
    if (!key || !existsSync(privatePath(key))) return reply.code(404).send({ error: 'Not found' });
    await audit(req.user.id, 'view_doc', { user: req.params.userId, which: req.params.which });
    return reply.header('Content-Type', MIME[extname(key)] || 'application/octet-stream').header('Cache-Control', 'private, no-store').send(createReadStream(privatePath(key)));
  });

  app.post('/admin/sellers/:id/:decision', g, async (req, reply) => {
    const { id, decision } = req.params;
    if (!isId(id) || !['approve', 'reject'].includes(decision)) return reply.code(404).send({ error: 'Not found' });
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const { rowCount } = await q('UPDATE sellers SET kyc=$2, kyc_note=$3 WHERE user_id=$1', [id, status, req.body?.note || null]);
    if (!rowCount) return reply.code(404).send({ error: 'Seller not found.' });
    await audit(req.user.id, `seller_${status}`, { seller: id });
    await bustItems();
    await notify(id, decision === 'approve'
      ? { title: 'You are approved to sell on Azure Sky 🎉', body: 'Your documents were verified. Your items are now visible to buyers.', link: '/seller' }
      : { title: 'Your seller application needs attention', body: req.body?.note || 'We could not verify your documents. Please contact support.', link: '/seller' });
    return { ok: true };
  });

  // ---- Payouts (sellers) ----
  app.get('/admin/payouts', g, async (req) => (await q(
    `SELECT p.*, o.number, se.business_name FROM payouts p JOIN orders o ON o.id=p.order_id JOIN sellers se ON se.user_id=p.seller_id
     WHERE ($1::text IS NULL OR p.status::text=$1) ORDER BY p.created_at DESC LIMIT 100`, [req.query.status || null])).rows);
  app.post('/admin/payouts/:id/mark-paid', g, async (req, reply) => {
    if (!isId(req.params.id)) return reply.code(404).send({ error: 'Not found' });
    const ok = await tx(async (c) => {
      const { rows } = await c.query("SELECT * FROM payouts WHERE id=$1 AND status IN ('queued','failed','processing') FOR UPDATE", [req.params.id]);
      if (!rows[0]) return false;
      await markPayoutPaid(c, rows[0], req.body?.reference || 'manual');
      return true;
    });
    if (!ok) return reply.code(404).send({ error: 'Payout not found or already paid.' });
    await audit(req.user.id, 'payout_marked_paid', { payout: req.params.id });
    return { ok: true };
  });
  app.post('/admin/payouts/:id/retry', g, async (req, reply) => {
    const { rows } = await q("UPDATE payouts SET status='queued', error=NULL WHERE id=$1 AND status='failed' RETURNING order_id", [isId(req.params.id) ? req.params.id : null]);
    if (!rows[0]) return reply.code(404).send({ error: 'Only failed payouts can be retried.' });
    await payoutQueue.add('payout', { orderId: rows[0].order_id });
    return { ok: true };
  });

  // ---- Disputes ----
  app.post('/admin/orders/:id/resolve', g, async (req, reply) => {
    const { action } = req.body || {};
    if (!isId(req.params.id) || !['release', 'refund'].includes(action)) return reply.code(400).send({ error: 'Choose release or refund.' });
    const done = action === 'release' ? await release(req.params.id, { by: 'admin' }) : await refundToWallet(req.params.id);
    if (!done) return reply.code(404).send({ error: 'Order cannot be resolved in its current state.' });
    await audit(req.user.id, `dispute_${action}`, { order: req.params.id });
    return { ok: true };
  });
}
