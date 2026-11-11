import { q } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';

const isId = (s) => /^[0-9a-f-]{36}$/.test(s || '');

export default async function (app) {
  const g = { preHandler: authenticate };

  app.get('/notifications', g, async (req) => (await q('SELECT id,title,body,link,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id])).rows);
  app.post('/notifications/read', g, async (req) => { await q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]); return { ok: true }; });

  // Inbox: latest message per order thread
  app.get('/messages', g, async (req) => (await q(
    `SELECT DISTINCT ON (m.order_id) m.order_id, o.number, m.body, m.created_at, (m.recipient_id=$1 AND m.read_at IS NULL) AS unread
     FROM messages m JOIN orders o ON o.id=m.order_id WHERE m.recipient_id=$1 OR m.sender_id=$1
     ORDER BY m.order_id, m.id DESC`, [req.user.id])).rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));

  // Buyer <-> seller chat inside an order
  app.post('/orders/:id/messages', g, async (req, reply) => {
    const body = String(req.body?.body || '').trim().slice(0, 1000);
    if (!body) return reply.code(400).send({ error: 'Type a message first.' });
    const { rows } = await q('SELECT buyer_id,seller_id,number FROM orders WHERE id=$1', [isId(req.params.id) ? req.params.id : null]);
    const o = rows[0];
    if (!o || ![o.buyer_id, o.seller_id].includes(req.user.id)) return reply.code(404).send({ error: 'Order not found.' });
    const to = req.user.id === o.buyer_id ? o.seller_id : o.buyer_id;
    await q('INSERT INTO messages(order_id,sender_id,recipient_id,body) VALUES($1,$2,$3,$4)', [req.params.id, req.user.id, to, body]);
    await q('INSERT INTO notifications(user_id,title,body,link) VALUES($1,$2,$3,$4)', [to, `New message on order #${o.number}`, body.slice(0, 120), `/orders/${req.params.id}`]);
    return { ok: true };
  });
}
