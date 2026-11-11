import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transport = config.smtp.host
  ? nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined })
  : nodemailer.createTransport({ jsonTransport: true }); // dev: logs the email instead of sending

export async function sendMail({ to, subject, html }) {
  const info = await transport.sendMail({ from: config.mailFrom, to, subject, html });
  if (!config.smtp.host) console.log('[mail:dev]', to, '|', subject);
  return info;
}
