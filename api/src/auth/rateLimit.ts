import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { redis } from '../lib/redis';

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 20;
const SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Rate limiter timed out')), milliseconds);
      timer.unref();
    }),
  ]);
}

async function increment(
  key: string,
  windowMs = WINDOW_MS
): Promise<{ count: number; ttl: number }> {
  const result = await timeout(
    redis.eval(SCRIPT, 1, key, String(windowMs)) as Promise<[number, number]>,
    1_500
  );
  return { count: Number(result[0]), ttl: Math.max(0, Number(result[1])) };
}

/** Shared Redis-backed limiter, consistent across horizontally scaled APIs. */
export async function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const identity = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase().slice(0, 320)
    : null;
  const keys = [
    `rate:auth:ip:${digest(req.ip || 'unknown')}`,
    ...(identity ? [`rate:auth:identity:${digest(identity)}`] : []),
  ];

  try {
    const counters = await Promise.all(keys.map(increment));
    const highest = counters.reduce((current, candidate) => (
      candidate.count > current.count ? candidate : current
    ));
    const remaining = Math.max(0, LIMIT - highest.count);
    res.setHeader('RateLimit-Limit', String(LIMIT));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(highest.ttl / 1000)));
    if (highest.count > LIMIT) {
      res.setHeader('Retry-After', String(Math.ceil(highest.ttl / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    return next();
  } catch {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Authentication is temporarily unavailable' });
    }
    return next();
  }
}

/**
 * Cheap pre-body protection for public provider endpoints. Provider
 * cryptographic verification remains authoritative; this only limits request
 * amplification before JSON/urlencoded parsing and signature checks.
 */
export async function providerWebhookRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const configured = Number(process.env.WEBHOOK_REQUESTS_PER_MINUTE ?? '600');
  const limit = Number.isInteger(configured) && configured >= 10 && configured <= 100_000
    ? configured
    : 600;
  try {
    const counter = await increment(
      `rate:webhook:ip:${digest(req.ip || 'unknown')}`,
      60_000
    );
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - counter.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(counter.ttl / 1000)));
    if (counter.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil(counter.ttl / 1000)));
      return res.status(429).json({ error: 'Too many webhook requests' });
    }
    return next();
  } catch {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Webhook admission control is unavailable' });
    }
    return next();
  }
}
