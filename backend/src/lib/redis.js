import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (e) => console.error('redis', e.message));

/** Cache-aside helper for hot read endpoints (home page, categories, item lists). */
export async function cached(key, ttlSec, loader) {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch { /* cache is best-effort */ }
  const val = await loader();
  try { await redis.set(key, JSON.stringify(val), 'EX', ttlSec); } catch { /* ignore */ }
  return val;
}
export async function bustItems() {
  const keys = await redis.keys('items:*').catch(() => []);
  if (keys.length) await redis.del(keys).catch(() => {});
}
