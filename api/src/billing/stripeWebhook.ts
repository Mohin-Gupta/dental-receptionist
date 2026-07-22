import crypto from 'crypto';
import { getStripeRuntimeConfig, getStripeWebhookSecrets } from './config';

export interface StripeEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: T };
}

export class StripeWebhookError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'StripeWebhookError';
  }
}

function parseSignatureHeader(header: string): { timestamp: string; signatures: string[] } {
  const values = new Map<string, string[]>();
  for (const component of header.split(',')) {
    const separator = component.indexOf('=');
    if (separator < 1) continue;
    const key = component.slice(0, separator).trim();
    const value = component.slice(separator + 1).trim();
    if (!key || !value) continue;
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  const timestamp = values.get('t')?.[0];
  const signatures = values.get('v1') ?? [];
  if (!timestamp || signatures.length === 0) {
    throw new StripeWebhookError('Invalid Stripe signature header');
  }
  return { timestamp, signatures };
}

function safeHexEqual(expected: Buffer, supplied: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(supplied)) return false;
  const received = Buffer.from(supplied, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function parseEvent(rawBody: Buffer): StripeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    throw new StripeWebhookError('Invalid Stripe event payload');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StripeWebhookError('Invalid Stripe event payload');
  }
  const event = parsed as Record<string, unknown>;
  const data = event.data;
  if (
    typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id) ||
    typeof event.type !== 'string' || event.type.length > 200 ||
    typeof event.created !== 'number' || !Number.isInteger(event.created) ||
    typeof event.livemode !== 'boolean' ||
    !data || typeof data !== 'object' || Array.isArray(data) ||
    !(data as Record<string, unknown>).object ||
    typeof (data as Record<string, unknown>).object !== 'object' ||
    Array.isArray((data as Record<string, unknown>).object)
  ) {
    throw new StripeWebhookError('Invalid Stripe event envelope');
  }
  return event as unknown as StripeEvent;
}

export function verifyStripeWebhook(rawBody: Buffer, signatureHeader: string): StripeEvent {
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  if (!/^\d{1,20}$/.test(timestamp)) {
    throw new StripeWebhookError('Invalid Stripe webhook timestamp');
  }

  const timestampSeconds = Number(timestamp);
  const tolerance = getStripeRuntimeConfig().webhookToleranceSeconds;
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > tolerance
  ) {
    throw new StripeWebhookError('Stripe webhook timestamp is outside the replay window');
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    rawBody,
  ]);
  const valid = getStripeWebhookSecrets().some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest();
    return signatures.some((signature) => safeHexEqual(expected, signature));
  });
  if (!valid) throw new StripeWebhookError('Invalid Stripe webhook signature');

  const event = parseEvent(rawBody);
  const expectedLivemode = getStripeRuntimeConfig().expectedLivemode;
  if (expectedLivemode !== undefined && event.livemode !== expectedLivemode) {
    throw new StripeWebhookError('Stripe event mode does not match this environment');
  }
  return event;
}
