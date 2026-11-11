import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../lib/redis.js';

const base = () => (config.airtel.env === 'production' ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa');

async function token() {
  const cached = await redis.get('airtel:token').catch(() => null);
  if (cached) return cached;
  const r = await fetch(`${base()}/auth/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    body: JSON.stringify({ client_id: config.airtel.id, client_secret: config.airtel.secret, grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`Airtel auth failed (${r.status})`);
  const j = await r.json();
  await redis.set('airtel:token', j.access_token, 'EX', Math.max(60, Number(j.expires_in) - 60)).catch(() => {});
  return j.access_token;
}

/** Airtel Money USSD-push collection. phone is 2547XXXXXXXX; Airtel expects the number without country code. */
export async function collect({ phone, amountCents, reference }) {
  const id = randomUUID().replace(/-/g, '').slice(0, 24);
  if (config.simulate) return { providerRef: `SIM-${id}` };
  const r = await fetch(`${base()}/merchant/v2/payments/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', 'X-Country': 'KE', 'X-Currency': 'KES' },
    body: JSON.stringify({
      reference: reference.slice(0, 64),
      subscriber: { country: 'KE', currency: 'KES', msisdn: phone.replace(/^254/, '') },
      transaction: { amount: Math.ceil(amountCents / 100), country: 'KE', currency: 'KES', id },
    }),
  });
  const j = await r.json();
  if (!r.ok || j?.status?.success === false) throw new Error(j?.status?.message || 'Airtel Money request failed');
  return { providerRef: id };
}

/**
 * Airtel disbursement needs an RSA-encrypted PIN and an enabled disbursement product on your Airtel account.
 * Integration point: until enabled, Airtel payouts stay queued for manual settlement in the admin console.
 */
export async function disburse() {
  throw Object.assign(new Error('Airtel disbursement not enabled — settle manually from the admin console'), { manual: true });
}

/** Airtel callback: { transaction: { id, status_code: "TS"|"TF"|..., airtel_money_id, message } } */
export function parseCallback(body) {
  const t = body?.transaction;
  if (!t) return null;
  return { providerRef: t.id, ok: t.status_code === 'TS', receipt: t.airtel_money_id || null, message: t.message };
}
