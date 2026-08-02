import crypto from 'node:crypto';
import {
  getRazorpayRuntimeConfig,
  getRazorpayWebhookSecrets,
} from './config';

export interface RazorpayWebhookPayloadEntry<
  T extends Record<string, unknown> = Record<string, unknown>
> {
  entity: T;
}

export interface RazorpayWebhookEvent {
  entity: 'event';
  account_id: string;
  event: string;
  contains: string[];
  payload: Record<string, RazorpayWebhookPayloadEntry>;
  created_at: number;
}

export interface VerifiedRazorpayWebhook {
  eventId: string;
  event: RazorpayWebhookEvent;
}

export class RazorpayWebhookError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'RazorpayWebhookError';
  }
}

function safeHexEqual(expected: Buffer, supplied: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(supplied)) return false;
  const received = Buffer.from(supplied, 'hex');
  return received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);
}

function parseEvent(rawBody: Buffer): RazorpayWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    throw new RazorpayWebhookError('Invalid Razorpay event payload');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RazorpayWebhookError('Invalid Razorpay event payload');
  }

  const event = parsed as Record<string, unknown>;
  if (
    event.entity !== 'event' ||
    typeof event.account_id !== 'string' ||
    !/^acc_[A-Za-z0-9]+$/.test(event.account_id) ||
    typeof event.event !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,199}$/.test(event.event) ||
    !Array.isArray(event.contains) ||
    event.contains.length > 50 ||
    event.contains.some(value =>
      typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(value)
    ) ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload) ||
    typeof event.created_at !== 'number' ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0
  ) {
    throw new RazorpayWebhookError('Invalid Razorpay event envelope');
  }

  const payload = event.payload as Record<string, unknown>;
  if (
    Object.keys(payload).length > 50 ||
    Object.entries(payload).some(([key, value]) =>
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(key) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !(value as Record<string, unknown>).entity ||
      typeof (value as Record<string, unknown>).entity !== 'object' ||
      Array.isArray((value as Record<string, unknown>).entity)
    )
  ) {
    throw new RazorpayWebhookError('Invalid Razorpay event payload');
  }

  return event as unknown as RazorpayWebhookEvent;
}

function validatedEventId(value: string): string {
  const eventId = value.trim();
  // Razorpay treats this as an opaque unique header. Restrict it to printable
  // non-whitespace ASCII so it is safe to persist and log without changing it.
  if (!/^[\x21-\x7E]{1,255}$/.test(eventId)) {
    throw new RazorpayWebhookError('Invalid Razorpay event ID');
  }
  return eventId;
}

export function verifyRazorpayWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  eventIdHeader: string
): VerifiedRazorpayWebhook {
  const eventId = validatedEventId(eventIdHeader);
  const signature = signatureHeader.trim();
  const valid = getRazorpayWebhookSecrets().some(secret => {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest();
    return safeHexEqual(expected, signature);
  });
  if (!valid) throw new RazorpayWebhookError('Invalid Razorpay webhook signature');

  const event = parseEvent(rawBody);
  const expectedAccountId = getRazorpayRuntimeConfig().accountId;
  if (expectedAccountId && event.account_id !== expectedAccountId) {
    throw new RazorpayWebhookError(
      'Razorpay event account does not match this environment'
    );
  }

  return { eventId, event };
}
