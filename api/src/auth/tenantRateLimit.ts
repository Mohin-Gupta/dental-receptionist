import crypto from 'crypto';
import type { Response } from 'express';
import { redis } from '../lib/redis';

const ACQUIRE_SCRIPT = `
local requests = redis.call('INCR', KEYS[1])
if requests == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if requests > tonumber(ARGV[2]) then return {0, requests, ttl, 0} end

local concurrent = redis.call('INCR', KEYS[2])
if concurrent == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
if concurrent > tonumber(ARGV[4]) then
  redis.call('DECR', KEYS[2])
  return {0, requests, ttl, 1}
end
return {1, requests, ttl, 2}
`;

const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then
  redis.call('DEL', KEYS[1])
  return 0
end
return redis.call('DECR', KEYS[1])
`;

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function timeout<T>(promise: Promise<T>, milliseconds = 1_500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tenant limiter timed out')), milliseconds);
      timer.unref();
    }),
  ]);
}

export async function acquireTenantRequestLease(
  organizationId: string,
  response: Response
): Promise<boolean> {
  const requestsPerMinute = boundedInteger(
    'TENANT_API_REQUESTS_PER_MINUTE',
    600,
    30,
    100_000
  );
  const maxConcurrent = boundedInteger(
    'TENANT_API_MAX_CONCURRENT_REQUESTS',
    25,
    1,
    1_000
  );
  const tenantKey = crypto.createHash('sha256').update(organizationId).digest('hex');
  const window = Math.floor(Date.now() / 60_000);
  const rateKey = `rate:tenant:${tenantKey}:${window}`;
  const concurrencyKey = `concurrency:tenant:${tenantKey}`;
  const result = await timeout(
    redis.eval(
      ACQUIRE_SCRIPT,
      2,
      rateKey,
      concurrencyKey,
      '60000',
      String(requestsPerMinute),
      '120000',
      String(maxConcurrent)
    ) as Promise<[number, number, number, number]>
  );
  const allowed = Number(result[0]) === 1;
  const leaseAcquired = Number(result[3]) === 2;
  response.setHeader('RateLimit-Limit', String(requestsPerMinute));
  response.setHeader('RateLimit-Remaining', String(Math.max(0, requestsPerMinute - Number(result[1]))));
  response.setHeader('RateLimit-Reset', String(Math.max(1, Math.ceil(Number(result[2]) / 1000))));

  if (leaseAcquired) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void redis.eval(RELEASE_SCRIPT, 1, concurrencyKey).catch(() => undefined);
    };
    response.once('finish', release);
    response.once('close', release);
  }
  return allowed;
}
