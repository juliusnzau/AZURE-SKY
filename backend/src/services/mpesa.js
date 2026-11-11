import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../lib/redis.js';

const base = () => (config.mpesa.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');
const cbUrl = (path) => `${config.publicUrl}/api/callbacks/${config.callbackSecret}/${path}`;

async function token() {
  const cached = await redis.get('mpesa:token').catch(() => null);
  if (cached) return cached;
  const auth = Buffer.from(`${config.mpesa.key}:${config.mpesa.secret}`).toString('base64');
  const r = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`Daraja auth failed (${r.status})`);
  const j = await r.json();
  await redis.set('mpesa:token', j.access_token, 'EX', Math.max(60, Number(j.expires_in) - 120)).catch(() => {});
  return j.access_token;
}
const ts = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);

/** Lipa Na M-Pesa Online (STK Push). Returns { providerRef } = CheckoutRequestID. */
export async function stkPush({ phone, amountCents, reference, description }) {
  if (config.simulate) return { providerRef: `SIM-${randomUUID()}` };
  const timestamp = ts();
  const password = Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${timestamp}`).toString('base64');
  const r = await fetch(`${base()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: config.mpesa.shortcode, Password: password, Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline', Amount: Math.ceil(amountCents / 100),
      PartyA: phone, PartyB: config.mpesa.shortcode, PhoneNumber: phone,
      CallBackURL: cbUrl('mpesa/stk'), AccountReference: reference.slice(0, 12), TransactionDesc: (description || 'Azure Sky').slice(0, 13),
    }),
  });
  const j = await r.json();
  if (!r.ok || j.ResponseCode !== '0') throw new Error(j.errorMessage || j.ResponseDescription || 'M-Pesa request failed');
  return { providerRef: j.CheckoutRequestID };
}

/** Business-to-Customer payout to a seller's M-Pesa number. The outcome arrives on the B2C result callback. */
export async function b2cPayout({ phone, amountCents, reference }) {
  if (config.simulate) return { providerRef: `SIM-B2C-${randomUUID()}`, simulated: true };
  const r = await fetch(`${base()}/mpesa/b2c/v1/paymentrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      InitiatorName: config.mpesa.initiator, SecurityCredential: config.mpesa.credential, CommandID: 'BusinessPayment',
      Amount: Math.floor(amountCents / 100), PartyA: config.mpesa.shortcode, PartyB: phone,
      Remarks: `Azure Sky payout ${reference}`.slice(0, 100), QueueTimeOutURL: cbUrl('mpesa/b2c/timeout'),
      ResultURL: cbUrl('mpesa/b2c/result'), Occasion: reference.slice(0, 100),
    }),
  });
  const j = await r.json();
  if (!r.ok || j.ResponseCode !== '0') throw new Error(j.errorMessage || j.ResponseDescription || 'M-Pesa B2C failed');
  return { providerRef: j.ConversationID };
}

/** Parse Daraja STK callback body into a neutral result. */
export function parseStk(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;
  const items = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
  return { providerRef: cb.CheckoutRequestID, ok: cb.ResultCode === 0, receipt: items.MpesaReceiptNumber || null, message: cb.ResultDesc };
}
