import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from './config.js';
import { pool, q } from './lib/db.js';
import { redis } from './lib/redis.js';
import { migrate } from './lib/migrate.js';
import { hashPassword } from './lib/auth.js';
import auth from './routes/auth.js';
import catalog from './routes/catalog.js';
import seller from './routes/seller.js';
import buyer from './routes/buyer.js';
import orders from './routes/orders.js';
import messages from './routes/messages.js';
import callbacks from './routes/callbacks.js';
import admin from './routes/admin.js';

const app = Fastify({ logger: { level: config.env === 'production' ? 'info' : 'debug' }, trustProxy: true, bodyLimit: 1_000_000 });

await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
await app.register(cors, { origin: config.env === 'production' ? config.publicUrl : true });
await app.register(jwt, { secret: config.jwtSecret });
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 8, fields: 40 } });
await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', redis });

// Public uploads (item photos, logos). In production nginx serves /files directly from the shared volume / CDN.
const pubDir = resolve(join(config.uploadDir, 'public'));
mkdirSync(pubDir, { recursive: true });
await app.register(fstatic, { root: pubDir, prefix: '/files/', maxAge: '30d', immutable: true });
// Dev convenience: serve the frontend from the API process when it sits next to the backend folder.
for (const dir of [resolve('../frontend'), resolve('./frontend')]) {
  if (existsSync(join(dir, 'index.html'))) { await app.register(fstatic, { root: dir, prefix: '/', decorateReply: false }); break; }
}

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode || 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: code >= 500 ? 'Something went wrong on our side. Please try again.' : err.message });
});

app.get('/api/health', async () => { await q('SELECT 1'); return { ok: true }; });
await app.register(async (api) => {
  for (const r of [auth, catalog, seller, buyer, orders, messages, callbacks, admin]) await api.register(r);
}, { prefix: '/api' });

async function bootstrapAdmin() {
  const { email, password } = config.admin;
  if (!email || !password) return;
  const { rows } = await q("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (rows[0]) return;
  await q(`INSERT INTO users(role,email,password_hash,full_name,phone,id_type,id_number,passport_photo,email_verified) VALUES('admin',$1,$2,'Azure Sky Admin','254700000000','national_id','ADMIN','n/a',true)`, [email.toLowerCase(), await hashPassword(password)]);
  app.log.warn(`Created first admin ${email} — change the password immediately.`);
}

try {
  if (await migrate()) app.log.info('Database schema applied');
  await bootstrapAdmin();
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
const stop = async () => { await app.close(); await pool.end(); redis.disconnect(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
