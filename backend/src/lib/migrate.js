import { readFileSync, existsSync } from 'node:fs';
import { pool } from './db.js';

/** Applies db/schema.sql once (idempotent: skips if the users table already exists). */
export async function migrate() {
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS t");
  if (rows[0].t) return false;
  const candidates = ['../../db/schema.sql', '../../../db/schema.sql'].map((p) => new URL(p, import.meta.url));
  const file = candidates.find((u) => existsSync(u));
  if (!file) throw new Error('schema.sql not found');
  await pool.query(readFileSync(file, 'utf8'));
  return true;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then((r) => { console.log(r ? 'Schema applied' : 'Schema already present'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
