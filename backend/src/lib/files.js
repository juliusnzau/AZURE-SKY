import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { join, extname } from 'node:path';
import { config } from '../config.js';

const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DOC = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

/**
 * Save an uploaded file. scope = "public" (served by nginx/CDN) or "private" (KYC; admins only via API).
 * For production, swap this module for S3/MinIO — the rest of the app only stores the returned key.
 */
export async function saveFile(part, scope, kind = 'image') {
  const ext = extname(part.filename || '').toLowerCase();
  if (!(kind === 'doc' ? DOC : IMG).has(ext)) throw Object.assign(new Error(`Unsupported file type ${ext || ''}`), { statusCode: 400 });
  const dir = join(config.uploadDir, scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = `${randomUUID()}${ext}`;
  await pipeline(part.file, createWriteStream(join(dir, key)));
  if (part.file.truncated) throw Object.assign(new Error('File too large (max 5 MB)'), { statusCode: 413 });
  return `${scope}/${key}`;
}
export const fileUrl = (key) => (key && key.startsWith('public/') ? `/files/${key.slice(7)}` : null);
export const privatePath = (key) => join(config.uploadDir, key);

/** Collect a multipart request: fields -> object, files -> saved keys. */
export async function readMultipart(req, fileSpecs) {
  const fields = {}; const files = {};
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const spec = fileSpecs[part.fieldname];
      if (!spec || !part.filename) { part.file.resume(); continue; }
      files[part.fieldname] = await saveFile(part, spec.scope, spec.kind);
    } else fields[part.fieldname] = part.value;
  }
  return { fields, files };
}
