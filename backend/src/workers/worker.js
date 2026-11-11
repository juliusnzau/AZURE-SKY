import { Worker } from 'bullmq';
import { config } from '../config.js';
import { q, tx } from '../lib/db.js';
import { queueConnection, maintenanceQueue } from '../lib/queue.js';
import { sendMail } from '../services/mailer.js';
import * as mpesa from '../services/mpesa.js';
import * as airtel from '../services/airtel.js';
import { cancelUnpaid, release, markPayoutPaid } from '../services/escrow.js';
import { notifyAdmins } from '../services/notify.js';

const log = (...a) => console.log('[worker]', ...a);

// ---- Email delivery (retries with exponential backoff) ----
new Worker('email', async (job) => { await sendMail(job.data); }, { connection: queueConnection, concurrency: 10 });

// ---- Seller payouts ----
new Worker('payout', async (job) => {
  const { orderId } = job.data;
  const p = await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM payouts WHERE order_id=$1 AND status IN ('queued','failed') FOR UPDATE", [orderId]);
    if (!rows[0]) return null;
    await c.query("UPDATE payouts SET status='processing' WHERE id=$1", [rows[0].id]);
    return rows[0];
  });
  if (!p) return;
  try {
    if (p.method === 'mpesa') {
      const r = await mpesa.b2cPayout({ phone: p.destination, amountCents: p.amount_cents, reference: String(orderId).slice(0, 8) });
      if (r.simulated) await tx(async (c) => markPayoutPaid(c, p, r.providerRef));
      else await q('UPDATE payouts SET provider_ref=$2 WHERE id=$1', [p.id, r.providerRef]); // result arrives on the B2C callback
    } else if (p.method === 'airtel') {
      if (config.simulate) await tx(async (c) => markPayoutPaid(c, p, 'SIM-AIRTEL'));
      else await airtel.disburse(p);
    } else {
      // Bank accounts / unset destination are settled manually (or via PesaLink bulk) from the admin console.
      await q("UPDATE payouts SET status='queued', error='Manual settlement required' WHERE id=$1", [p.id]);
      await notifyAdmins({ title: 'Manual payout needed', body: `KES ${(p.amount_cents / 100).toFixed(2)} to ${p.destination}`, link: '/admin' });
    }
  } catch (err) {
    await q("UPDATE payouts SET status=$2, error=$3 WHERE id=$1", [p.id, err.manual ? 'queued' : 'failed', String(err.message).slice(0, 300)]);
    if (err.manual) await notifyAdmins({ title: 'Manual payout needed', body: `${p.method} payout of KES ${(p.amount_cents / 100).toFixed(2)} to ${p.destination}`, link: '/admin' });
    else throw err; // let BullMQ retry
  }
}, { connection: queueConnection, concurrency: 5 });

// ---- Housekeeping: expire unpaid orders, auto-release long-shipped orders ----
new Worker('maintenance', async () => {
  const stale = await q("SELECT id FROM orders WHERE status='pending_payment' AND created_at < now() - ($1 || ' minutes')::interval LIMIT 200", [String(config.paymentTimeoutMin)]);
  for (const o of stale.rows) await cancelUnpaid(o.id, 'Payment was not received in time, so the order was cancelled and stock released.').catch((e) => log('cancel', e.message));
  const due = await q("SELECT id FROM orders WHERE status='shipped' AND shipped_at < now() - ($1 || ' days')::interval LIMIT 200", [String(config.autoReleaseDays)]);
  for (const o of due.rows) await release(o.id, { by: 'auto' }).catch((e) => log('release', e.message));
  if (stale.rowCount || due.rowCount) log(`cancelled ${stale.rowCount} unpaid, auto-released ${due.rowCount}`);
}, { connection: queueConnection });
await maintenanceQueue.add('tick', {}, { repeat: { every: 5 * 60 * 1000 }, jobId: 'tick', removeOnComplete: 50, removeOnFail: 50 });

log('workers started: email, payout, maintenance');
