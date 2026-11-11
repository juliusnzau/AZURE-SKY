import { Queue } from 'bullmq';
import { config } from '../config.js';

export const queueConnection = { url: config.redisUrl, maxRetriesPerRequest: null };
const opts = (delay) => ({ connection: queueConnection, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay }, removeOnComplete: 1000, removeOnFail: 5000 } });
export const emailQueue = new Queue('email', opts(5000));
export const payoutQueue = new Queue('payout', opts(30000));
export const maintenanceQueue = new Queue('maintenance', { connection: queueConnection });
