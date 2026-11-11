import { tx } from '../lib/db.js';
import { config } from '../config.js';
import { commissionOf } from '../lib/money.js';
import { post, ensureWallet } from './ledger.js';
import { notify } from './notify.js';
import { payoutQueue } from '../lib/queue.js';

export const KES = (c) => `KES ${(c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Buyer's money has arrived (M-Pesa/Airtel/wallet). Move it into escrow, fix commission, notify both sides. */
export async function markPaid(c, orderId, { provider, source }) {
  const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 AND status='pending_payment' FOR UPDATE", [orderId]);
  const o = rows[0];
  if (!o) return null;
  const commission = commissionOf(o.total_cents);
  await c.query("UPDATE orders SET status='paid_held', paid_at=now(), commission_cents=$2, seller_net_cents=$3 WHERE id=$1", [orderId, commission, o.total_cents - commission]);
  await post(c, [[source, -o.total_cents], ['escrow', o.total_cents]], { orderId, memo: `Payment received via ${provider}` });
  const no = `#${o.number}`;
  await notify(o.buyer_id, { title: `Payment received for order ${no}`, body: `We're holding ${KES(o.total_cents)} safely until you confirm delivery.`, link: `/orders/${o.id}`, orderId, db: c });
  await notify(o.seller_id, { title: `Order ${no} is paid — please deliver`, body: `The buyer has paid ${KES(o.total_cents)}. Ship the items and mark the order as shipped.`, link: `/orders/${o.id}`, orderId, db: c });
  return o;
}

/** Delivery confirmed (buyer), auto-released (timer) or resolved by admin: escrow -> seller (less commission) + platform. */
export async function release(orderId, { by = 'buyer' } = {}) {
  const done = await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 AND status IN ('shipped','disputed','paid_held') FOR UPDATE", [orderId]);
    const o = rows[0];
    if (!o) return null;
    if (by !== 'admin' && o.status !== 'shipped') return null;
    await c.query("UPDATE orders SET status='completed', completed_at=now() WHERE id=$1", [orderId]);
    await post(c, [['escrow', -o.total_cents], [`seller:${o.seller_id}`, o.seller_net_cents], ['platform', o.commission_cents]], { orderId, memo: `Released (${by}); ${(config.commissionRate * 100).toFixed(0)}% commission` });
    const { rows: pa } = await c.query('SELECT * FROM payment_accounts WHERE user_id=$1 ORDER BY is_default DESC LIMIT 1', [o.seller_id]);
    const a = pa[0];
    await c.query('INSERT INTO payouts(order_id,seller_id,amount_cents,method,destination) VALUES($1,$2,$3,$4,$5)', [orderId, o.seller_id, o.seller_net_cents, a?.kind || 'unset', a ? (a.kind === 'bank' ? `${a.bank_name} ${a.account_number}` : a.phone) : 'unset']);
    const no = `#${o.number}`;
    await notify(o.buyer_id, { title: `Order ${no} completed`, body: 'Thanks for shopping on Azure Sky. The seller has been paid.', link: `/orders/${o.id}`, orderId, db: c });
    await notify(o.seller_id, { title: `Order ${no} completed — payout on the way`, body: `${KES(o.seller_net_cents)} is being sent to you (total ${KES(o.total_cents)} less ${KES(o.commission_cents)} Azure Sky commission).`, link: `/orders/${o.id}`, orderId, db: c });
    return o;
  });
  if (done) await payoutQueue.add('payout', { orderId }, { jobId: `payout-${orderId}` });
  return done;
}

export async function restock(c, orderId) {
  await c.query('UPDATE items i SET quantity=i.quantity+oi.quantity FROM order_items oi WHERE oi.order_id=$1 AND oi.item_id=i.id', [orderId]);
}

/** Refund escrow to the buyer's wallet (admin dispute resolution). */
export async function refundToWallet(orderId) {
  return tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 AND status IN ('paid_held','shipped','disputed') FOR UPDATE", [orderId]);
    const o = rows[0];
    if (!o) return null;
    await ensureWallet(c, o.buyer_id);
    await c.query('UPDATE wallets SET balance_cents=balance_cents+$2 WHERE user_id=$1', [o.buyer_id, o.total_cents]);
    await c.query("UPDATE orders SET status='refunded', commission_cents=0, seller_net_cents=0 WHERE id=$1", [orderId]);
    await restock(c, orderId);
    await post(c, [['escrow', -o.total_cents], [`wallet:${o.buyer_id}`, o.total_cents]], { orderId, memo: 'Refund to buyer wallet' });
    await notify(o.buyer_id, { title: `Order #${o.number} refunded`, body: `${KES(o.total_cents)} was returned to your Azure Sky wallet.`, link: '/wallet', orderId, db: c });
    await notify(o.seller_id, { title: `Order #${o.number} refunded to buyer`, body: 'After review, this order was refunded to the buyer.', link: `/orders/${o.id}`, orderId, db: c });
    return o;
  });
}

/** Cancel an unpaid order and return reserved stock. */
export async function cancelUnpaid(orderId, reason) {
  return tx(async (c) => {
    const { rows } = await c.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending_payment' RETURNING *", [orderId]);
    const o = rows[0];
    if (!o) return null;
    await restock(c, orderId);
    await notify(o.buyer_id, { title: `Order #${o.number} cancelled`, body: reason, link: `/orders/${o.id}`, orderId, db: c });
    await notify(o.seller_id, { title: `Order #${o.number} cancelled`, body: 'The buyer did not complete payment.', link: `/orders/${o.id}`, orderId, db: c, email: false });
    return o;
  });
}

/** Record a finished payout (money left the platform to the seller). */
export async function markPayoutPaid(c, payout, ref) {
  await c.query("UPDATE payouts SET status='paid', provider_ref=COALESCE($2,provider_ref), error=NULL WHERE id=$1", [payout.id, ref || null]);
  await post(c, [[`seller:${payout.seller_id}`, -payout.amount_cents], ['ext:payout', payout.amount_cents]], { orderId: payout.order_id, memo: `Payout via ${payout.method}` });
}

/**
 * Settle an in-flight order payment or wallet top-up from a provider result (callback, simulator or status query).
 * Idempotent: a row only transitions once out of 'initiated'.
 */
export async function settleProviderResult(provider, { providerRef, ok, receipt, message, raw }) {
  return tx(async (c) => {
    const { rows: pr } = await c.query("SELECT * FROM payments WHERE provider=$1 AND provider_ref=$2 AND status='initiated' FOR UPDATE", [provider, providerRef]);
    if (pr[0]) {
      const p = pr[0];
      await c.query('UPDATE payments SET status=$2, receipt=$3, raw=$4 WHERE id=$1', [p.id, ok ? 'success' : 'failed', receipt, raw || null]);
      if (ok) await markPaid(c, p.order_id, { provider, source: `ext:${provider}` });
      else {
        const { rows } = await c.query('SELECT buyer_id, number FROM orders WHERE id=$1', [p.order_id]);
        if (rows[0]) await notify(rows[0].buyer_id, { title: `Payment for order #${rows[0].number} didn't go through`, body: `${message || 'The payment was cancelled or failed.'} You can try again from your orders page.`, link: `/orders/${p.order_id}`, orderId: p.order_id, db: c });
      }
      return 'payment';
    }
    const { rows: tr } = await c.query("SELECT * FROM topups WHERE provider=$1 AND provider_ref=$2 AND status='initiated' FOR UPDATE", [provider, providerRef]);
    if (tr[0]) {
      const t = tr[0];
      await c.query('UPDATE topups SET status=$2, receipt=$3, raw=$4 WHERE id=$1', [t.id, ok ? 'success' : 'failed', receipt, raw || null]);
      if (ok) {
        await ensureWallet(c, t.user_id);
        await c.query('UPDATE wallets SET balance_cents=balance_cents+$2 WHERE user_id=$1', [t.user_id, t.amount_cents]);
        await post(c, [[`ext:${provider}`, -t.amount_cents], [`wallet:${t.user_id}`, t.amount_cents]], { memo: 'Wallet top-up' });
        await notify(t.user_id, { title: 'Wallet topped up', body: `${KES(t.amount_cents)} was added to your wallet.`, link: '/wallet', email: false, db: c });
      } else await notify(t.user_id, { title: 'Wallet top-up failed', body: message || 'The payment was cancelled or failed.', link: '/wallet', email: false, db: c });
      return 'topup';
    }
    return null;
  });
}

/** In simulation mode, auto-complete a push payment a few seconds later (no real money moves). */
export function simulateResult(provider, providerRef, ok = true) {
  if (!config.simulate) return;
  setTimeout(() => settleProviderResult(provider, { providerRef, ok, receipt: `SIM${Date.now().toString(36).toUpperCase()}`, message: ok ? 'ok' : 'Cancelled' }).catch((e) => console.error('simulate', e)), 3500);
}
