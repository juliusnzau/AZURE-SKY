const e = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
export const config = {
  env: e.NODE_ENV || 'development',
  port: num(e.PORT, 4000),
  publicUrl: e.PUBLIC_URL || 'http://localhost:8080',
  databaseUrl: e.DATABASE_URL || 'postgres://azure:azure@localhost:5432/azuresky',
  redisUrl: e.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: e.JWT_SECRET || 'dev-secret-change-me',
  uploadDir: e.UPLOAD_DIR || './uploads',
  commissionRate: num(e.COMMISSION_RATE, 0.03),
  autoReleaseDays: num(e.AUTO_RELEASE_DAYS, 7),
  paymentTimeoutMin: num(e.PAYMENT_TIMEOUT_MINUTES, 30),
  deliveryFeeCents: num(e.DELIVERY_FEE_KES, 200) * 100,
  vatRate: num(e.VAT_RATE, 0.16),
  callbackSecret: e.CALLBACK_SECRET || 'dev-callback-secret',
  simulate: (e.PAYMENTS_SIMULATE ?? 'true') === 'true',
  smtp: { host: e.SMTP_HOST, port: num(e.SMTP_PORT, 587), user: e.SMTP_USER, pass: e.SMTP_PASS },
  mailFrom: e.MAIL_FROM || 'Azure Sky <no-reply@azuresky.co.ke>',
  mpesa: {
    env: e.MPESA_ENV || 'sandbox', key: e.MPESA_CONSUMER_KEY, secret: e.MPESA_CONSUMER_SECRET,
    shortcode: e.MPESA_SHORTCODE, passkey: e.MPESA_PASSKEY,
    initiator: e.MPESA_INITIATOR_NAME, credential: e.MPESA_SECURITY_CREDENTIAL,
  },
  airtel: { env: e.AIRTEL_ENV || 'sandbox', id: e.AIRTEL_CLIENT_ID, secret: e.AIRTEL_CLIENT_SECRET },
  admin: { email: e.ADMIN_EMAIL, password: e.ADMIN_PASSWORD },
};
if (config.env === 'production') {
  const weak = (s) => s.startsWith('dev-') || s.startsWith('change-me');
  if (weak(config.jwtSecret) || weak(config.callbackSecret)) throw new Error('Set strong JWT_SECRET and CALLBACK_SECRET in production');
  if (config.simulate) throw new Error('PAYMENTS_SIMULATE must be false in production');
}
