import { copyFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { q, tx } from '../lib/db.js';
import { config } from '../config.js';
import { hashPassword, checkPassword, authenticate } from '../lib/auth.js';
import { readMultipart, fileUrl } from '../lib/files.js';
import { normalizePhone, slugify } from '../lib/money.js';
import { ensureWallet } from '../services/ledger.js';
import { emailQueue } from '../lib/queue.js';
import { emailHtml, esc, notify } from '../services/notify.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const KRA = /^[AP][0-9]{9}[A-Z]$/;
const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

function validateCommon(f, files) {
  if (!f.full_name?.trim()) throw bad('Enter your full name.');
  if (!EMAIL.test(f.email || '')) throw bad('Enter a valid email address.');
  if ((f.password || '').length < 8) throw bad('Password must be at least 8 characters.');
  const phone = normalizePhone(f.phone);
  if (!phone) throw bad('Enter a valid Kenyan phone number, e.g. 0712345678.');
  if (!['national_id', 'passport'].includes(f.id_type)) throw bad('Choose National ID or Passport.');
  if (!f.id_number?.trim()) throw bad('Enter your ID or passport number.');
  if (!files.passport_photo) throw bad('Upload your passport photo.');
  return phone;
}
function paymentAccount(f) {
  const kind = f.account_kind;
  if (kind === 'bank') {
    if (!f.bank_name || !f.account_number) throw bad('Enter your bank name and account number.');
    return { kind, bank_name: f.bank_name, account_number: f.account_number, account_name: f.account_name || f.full_name, phone: null };
  }
  if (!['mpesa', 'airtel'].includes(kind)) throw bad('Choose M-Pesa, Airtel Money or Bank for payments.');
  const p = normalizePhone(f.account_phone);
  if (!p) throw bad('Enter a valid mobile money phone number.');
  return { kind, phone: p, bank_name: null, account_number: null, account_name: null };
}
function dupe(err) {
  if (err.code === '23505') throw bad(err.constraint === 'users_email_key' ? 'An account with this email already exists.' : 'An account with this ID/passport number already exists.');
  throw err;
}

export default async function (app) {
  const FILES_BUYER = { passport_photo: { scope: 'private', kind: 'image' } };
  const FILES_SELLER = { passport_photo: { scope: 'private', kind: 'image' }, registration_cert: { scope: 'private', kind: 'doc' }, logo: { scope: 'public', kind: 'image' } };
  const lim = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  async function sendVerification(user) {
    const token = app.jwt.sign({ id: user.id, purpose: 'verify' }, { expiresIn: '2d' });
    await emailQueue.add('send', { to: user.email, subject: 'Verify your Azure Sky email', html: emailHtml('Welcome to Azure Sky ☁', `Hi ${esc(user.full_name)}, please confirm your email address to finish setting up your account.`, `/verify/${token}`) });
  }
  const insertUser = (c, role, f, phone, files) => c.query(
    `INSERT INTO users(role,email,password_hash,full_name,phone,id_type,id_number,passport_photo) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,email,full_name`,
    [role, f.email.toLowerCase(), f.__hash, f.full_name.trim(), phone, f.id_type, f.id_number.trim(), files.passport_photo]);
  const insertAccount = (c, uid, a) => c.query('INSERT INTO payment_accounts(user_id,kind,phone,bank_name,account_number,account_name) VALUES($1,$2,$3,$4,$5,$6)', [uid, a.kind, a.phone, a.bank_name, a.account_number, a.account_name]);

  app.post('/auth/register/buyer', lim, async (req, reply) => {
    const { fields: f, files } = await readMultipart(req, FILES_BUYER);
    const phone = validateCommon(f, files);
    const acct = paymentAccount(f);
    f.__hash = await hashPassword(f.password);
    const user = await tx(async (c) => {
      const u = (await insertUser(c, 'buyer', f, phone, files)).rows[0];
      await insertAccount(c, u.id, acct);
      await ensureWallet(c, u.id);
      return u;
    }).catch(dupe);
    await sendVerification(user);
    return reply.code(201).send({ token: app.jwt.sign({ id: user.id, role: 'buyer' }, { expiresIn: '7d' }) });
  });

  app.post('/auth/register/seller', lim, async (req, reply) => {
    const { fields: f, files } = await readMultipart(req, FILES_SELLER);
    const phone = validateCommon(f, files);
    if (!f.business_name?.trim()) throw bad('Enter your business name.');
    if (!f.registration_no?.trim()) throw bad('Enter your business registration number.');
    if (!files.registration_cert) throw bad('Upload your business registration certificate.');
    if (!KRA.test((f.kra_pin || '').toUpperCase())) throw bad('Enter a valid KRA PIN, e.g. A123456789Z.');
    const acct = paymentAccount(f);
    // The logo may be alternated with the passport photo: copy it into the public area.
    let logo = files.logo;
    if (!logo) {
      mkdirSync(join(config.uploadDir, 'public'), { recursive: true });
      const key = `${randomUUID()}${extname(files.passport_photo)}`;
      copyFileSync(join(config.uploadDir, files.passport_photo), join(config.uploadDir, 'public', key));
      logo = `public/${key}`;
    }
    f.__hash = await hashPassword(f.password);
    const user = await tx(async (c) => {
      const u = (await insertUser(c, 'seller', f, phone, files)).rows[0];
      await c.query('INSERT INTO sellers(user_id,business_name,registration_no,registration_cert,kra_pin,logo) VALUES($1,$2,$3,$4,$5,$6)', [u.id, f.business_name.trim(), f.registration_no.trim(), files.registration_cert, f.kra_pin.toUpperCase(), logo]);
      await insertAccount(c, u.id, acct);
      await c.query('INSERT INTO shops(seller_id,name,slug,description) VALUES($1,$2,$3,$4)', [u.id, f.business_name.trim(), `${slugify(f.business_name)}-${u.id.slice(0, 4)}`, '']);
      return u;
    }).catch(dupe);
    await sendVerification(user);
    await notify(user.id, { title: 'Your seller account is under review', body: 'We are verifying your documents. You can set up your shop now; items go live once you are approved.', link: '/seller', email: false });
    return reply.code(201).send({ token: app.jwt.sign({ id: user.id, role: 'seller' }, { expiresIn: '7d' }) });
  });

  app.post('/auth/login', lim, async (req, reply) => {
    const { email, password } = req.body || {};
    const { rows } = await q('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase()]);
    const u = rows[0];
    if (!u || !(await checkPassword(String(password || ''), u.password_hash))) return reply.code(401).send({ error: 'Email or password is incorrect.' });
    if (u.status !== 'active') return reply.code(403).send({ error: 'This account is suspended. Contact support.' });
    return { token: app.jwt.sign({ id: u.id, role: u.role }, { expiresIn: '7d' }) };
  });

  app.get('/auth/verify/:token', async (req, reply) => {
    try {
      const p = app.jwt.verify(req.params.token);
      if (p.purpose !== 'verify') throw new Error('bad');
      await q('UPDATE users SET email_verified=true WHERE id=$1', [p.id]);
      return { ok: true };
    } catch { return reply.code(400).send({ error: 'This verification link is invalid or has expired.' }); }
  });

  app.get('/me', { preHandler: authenticate }, async (req) => {
    const { rows } = await q(
      `SELECT u.id,u.role,u.email,u.full_name,u.phone,u.email_verified,
              s.business_name,s.kyc,s.kyc_note,s.logo,
              COALESCE((SELECT balance_cents FROM wallets w WHERE w.user_id=u.id),0) AS wallet_cents,
              (SELECT count(*) FROM notifications n WHERE n.user_id=u.id AND n.read_at IS NULL)::int AS unread_notifications,
              (SELECT count(*) FROM messages m WHERE m.recipient_id=u.id AND m.read_at IS NULL)::int AS unread_messages,
              (SELECT count(*) FROM cart_items ci WHERE ci.user_id=u.id)::int AS cart_count
       FROM users u LEFT JOIN sellers s ON s.user_id=u.id WHERE u.id=$1`, [req.user.id]);
    const me = rows[0];
    if (me?.logo) me.logo_url = fileUrl(me.logo);
    delete me?.logo;
    return me;
  });
}
