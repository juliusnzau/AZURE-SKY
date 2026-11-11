import { q, tx } from '../lib/db.js';
import { config } from '../config.js';
import * as mpesa from '../services/mpesa.js';
import * as airtel from '../services/airtel.js';
import { settleProviderResult, markPayoutPaid } from '../services/escrow.js';
import { notifyAdmins, notify } from '../services/notify.js';

/**
 * Payment-provider webhooks. The secret path segment is the first line of defence; in production also restrict
 * these paths to Safaricom/Airtel source IPs at nginx (see nginx/nginx.conf) and rely on idempotent settlement.
 */
export default async function (app) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.params.secret !== config.callbackSecret) return reply.code(404).send({ error: 'Not found' });
  });
  const ack = { ResultCode: 0, ResultDesc: 'Accepted' };

  app.post('/callbacks/:secret/mpesa/stk', async (req) => {
    const r = mpesa.parseStk(req.body);
    if (r) await settleProviderResult('mpesa', { ...r, raw: req.body });
    return ack;
  });

  app.post('/callbacks/:secret/airtel/collect', async (req) => {
    const r = airtel.parseCallback(req.body);
    if (r) await settleProviderResult('airtel', { ...r, raw: req.body });
    return { ok: true };
  });

  // B2C payout result
  app.post('/callbacks/:secret/mpesa/b2c/result', async (req) => {
    const res = req.body?.Result;
    if (res) {
      const ok = res.ResultCode === 0;
      await tx(async (c) => {
        const { rows } = await c.query("SELECT * FROM payouts WHERE provider_ref=$1 AND status='processing' FOR UPDATE", [res.ConversationID]);
        const p = rows[0];
        if (!p) return;
        if (ok) await markPayoutPaid(c, p, res.TransactionID);
        else await c.query("UPDATE payouts SET status='failed', error=$2 WHERE id=$1", [p.id, String(res.ResultDesc || 'failed').slice(0, 300)]);
      });
      if (!ok) await notifyAdmins({ title: 'Payout failed', body: `${res.ResultDesc || 'B2C payout failed'} — retry from the admin console.`, link: '/admin' });
    }
    return ack;
  });
  app.post('/callbacks/:secret/mpesa/b2c/timeout', async (req) => {
    const cid = req.body?.Result?.ConversationID;
    if (cid) await q("UPDATE payouts SET status='failed', error='Timed out' WHERE provider_ref=$1 AND status='processing'", [cid]);
    return ack;
  });
}
