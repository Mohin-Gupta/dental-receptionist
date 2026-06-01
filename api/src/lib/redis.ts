import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) throw new Error('REDIS_URL not set');

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null, // required for BullMQ
});

export const redisConnection = {
  connection: new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  }),
};