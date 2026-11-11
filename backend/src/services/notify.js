import { q } from '../lib/db.js';
import { emailQueue } from '../lib/queue.js';
import { config } from '../config.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const emailHtml = (title, body, link) => `<!doctype html><html><body style="margin:0;background:#e8f4ff;font-family:Arial,sans-serif">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #cfe6fb">
<div style="background:linear-gradient(135deg,#1e90ff,#6ec6ff);padding:20px 24px;color:#fff;font-size:22px;font-weight:700">☁ Azure Sky</div>
<div style="padding:24px;color:#0b2545"><h2 style="margin:0 0 12px">${title}</h2><div style="line-height:1.6">${body}</div>
${link ? `<p><a href="${config.publicUrl}/#${link}" style="background:#1e90ff;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;display:inline-block">Open in Azure Sky</a></p>` : ''}
</div></div></body></html>`;

/**
 * Notify a user on the website (notification + order message thread) AND by email.
 * Pass `db` (a pg client) to join the caller's transaction. `emailBody` is trusted HTML (escape user data with esc()).
 */
export async function notify(userId, { title, body, link, orderId = null, email = true, emailBody = null, db = null }) {
  const run = db ? db.query.bind(db) : q;
  await run('INSERT INTO notifications(user_id,title,body,link) VALUES($1,$2,$3,$4)', [userId, title, body, link || null]);
  if (orderId) await run('INSERT INTO messages(order_id,sender_id,recipient_id,body) VALUES($1,NULL,$2,$3)', [orderId, userId, `${title} — ${body}`]);
  if (email) {
    const { rows } = await run('SELECT email FROM users WHERE id=$1', [userId]);
    if (rows[0]) await emailQueue.add('send', { to: rows[0].email, subject: `Azure Sky: ${title}`, html: emailHtml(esc(title), emailBody || esc(body), link) });
  }
}
export async function notifyAdmins(payload) {
  const { rows } = await q("SELECT id FROM users WHERE role='admin'");
  for (const a of rows) await notify(a.id, { ...payload, email: false });
}
