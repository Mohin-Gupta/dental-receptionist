import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) throw new Error('REDIS_URL not set');

export const redis = new Redis(redisUrl, {
  // This connection serves request-path state and security controls, not
  // BullMQ. Bound retries so an unavailable Redis cannot hang HTTP requests.
  maxRetriesPerRequest: 1,
  connectTimeout: 5_000,
});
