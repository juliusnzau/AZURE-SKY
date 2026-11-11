import pg from 'pg';
import { config } from '../config.js';

// BIGINT -> JS number is safe here (KES cents never approach 2^53)
pg.types.setTypeParser(20, (v) => Number(v));
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.PG_POOL_MAX || 20) });
export const q = (text, params) => pool.query(text, params);

/** Run fn inside a transaction. fn receives a client. */
export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
