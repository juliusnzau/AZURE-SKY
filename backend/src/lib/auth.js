import bcrypt from 'bcryptjs';
import { q } from './db.js';

export const hashPassword = (p) => bcrypt.hash(p, 11);
export const checkPassword = (p, h) => bcrypt.compare(p, h);

/** Fastify preHandler: requires a valid JWT. */
export async function authenticate(req, reply) {
  try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'Please sign in to continue.' }); }
}
/** Require one of the given roles. */
export const requireRole = (...roles) => async (req, reply) => {
  await authenticate(req, reply);
  if (reply.sent) return;
  if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'You do not have access to this.' });
};
/** Sellers may only act on shops they own. Returns the shop row or sends 404. */
export async function ownShop(req, reply, shopId) {
  if (!/^[0-9a-f-]{36}$/.test(shopId || '')) { reply.code(404).send({ error: 'Shop not found.' }); return null; }
  const { rows } = await q('SELECT * FROM shops WHERE id=$1 AND seller_id=$2', [shopId, req.user.id]);
  if (!rows[0]) { reply.code(404).send({ error: 'Shop not found.' }); return null; }
  return rows[0];
}
