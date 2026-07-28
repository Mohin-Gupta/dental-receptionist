import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) throw new Error('REDIS_URL not set');

export const redis = new Redis(redisUrl, {
  // Railway private DNS is dual-stack; let Node select IPv4 or IPv6.
  family: 0,
  // This connection serves request-path state and security controls, not
  // BullMQ. Bound retries so an unavailable Redis cannot hang HTTP requests.
  maxRetriesPerRequest: 1,
  connectTimeout: 5_000,
});
