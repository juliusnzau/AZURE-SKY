import { randomUUID } from 'node:crypto';

/** Post a balanced set of ledger entries. entries: [[account, amountCents], ...] must sum to 0. */
export async function post(c, entries, { orderId = null, memo = '' } = {}) {
  const sum = entries.reduce((s, [, a]) => s + a, 0);
  if (sum !== 0) throw new Error(`Unbalanced ledger txn (${sum})`);
  const txn = randomUUID();
  for (const [account, amount] of entries) {
    if (amount === 0) continue;
    await c.query('INSERT INTO ledger(txn_id,account,amount_cents,order_id,memo) VALUES($1,$2,$3,$4,$5)', [txn, account, amount, orderId, memo]);
  }
  return txn;
}
export async function ensureWallet(c, userId) {
  await c.query('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING', [userId]);
}
