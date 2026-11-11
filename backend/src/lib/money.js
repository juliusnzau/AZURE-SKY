import { config } from '../config.js';

/** Split a listed price into net + VAT (cents). */
export function priceParts(item) {
  const rate = item.tax === 'vat_16' ? config.vatRate : 0;
  const listed = Number(item.price_cents);
  if (!rate) return { net: listed, tax: 0 };
  if (item.tax_inclusive) {
    const net = Math.round(listed / (1 + rate));
    return { net, tax: listed - net };
  }
  return { net: listed, tax: Math.round(listed * rate) };
}
export const commissionOf = (totalCents) => Math.round(totalCents * config.commissionRate);

/** Normalise Kenyan numbers to 2547XXXXXXXX / 2541XXXXXXXX. Returns null if invalid. */
export function normalizePhone(p) {
  const d = String(p || '').replace(/[\s\-()+]/g, '');
  const m = d.match(/^(?:254|0)?([17]\d{8})$/);
  return m ? `254${m[1]}` : null;
}
export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
