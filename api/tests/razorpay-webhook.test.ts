import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import {
  RazorpayWebhookError,
  verifyRazorpayWebhook,
} from '../src/billing/razorpayWebhook';

const ENV_KEYS = [
  'NODE_ENV',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_EXPECT_KEY_MODE',
  'RAZORPAY_ACCOUNT_ID',
  'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAY_WEBHOOK_SECRETS',
] as const;
const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

const currentSecret = 'current_webhook_secret_32_bytes_long';
const previousSecret = 'previous_webhook_secret_32_bytes_long';

function eventBody(accountId = 'acc_UnitTest'): Buffer {
  return Buffer.from(JSON.stringify({
    entity: 'event',
    account_id: accountId,
    event: 'subscription.activated',
    contains: ['subscription'],
    payload: {
      subscription: {
        entity: {
          id: 'sub_UnitTest',
          entity: 'subscription',
          plan_id: 'plan_UnitTest',
          status: 'active',
        },
      },
    },
    created_at: 1_722_000_000,
  }));
}

function signature(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_UnitTest';
  process.env.RAZORPAY_KEY_SECRET = 'unit_test_key_secret_long_enough';
  process.env.RAZORPAY_EXPECT_KEY_MODE = 'test';
  process.env.RAZORPAY_ACCOUNT_ID = 'acc_UnitTest';
  process.env.RAZORPAY_WEBHOOK_SECRET = currentSecret;
  process.env.RAZORPAY_WEBHOOK_SECRETS = previousSecret;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('accepts the exact raw payload using an overlapping rotation secret', () => {
  const body = eventBody();
  const verified = verifyRazorpayWebhook(
    body,
    signature(body, previousSecret),
    'event-header-id_123'
  );

  assert.equal(verified.eventId, 'event-header-id_123');
  assert.equal(verified.event.event, 'subscription.activated');
});

test('rejects a body changed after Razorpay signed it', () => {
  const body = eventBody();
  const header = signature(body, currentSecret);
  const changed = Buffer.from(
    body.toString('utf8').replace('subscription.activated', 'subscription.cancelled')
  );

  assert.throws(
    () => verifyRazorpayWebhook(changed, header, 'event-header-id_123'),
    (error: unknown) =>
      error instanceof RazorpayWebhookError && /signature/.test(error.message)
  );
});

test('rejects malformed event IDs before accepting a webhook for deduplication', () => {
  const body = eventBody();
  assert.throws(
    () => verifyRazorpayWebhook(body, signature(body, currentSecret), 'bad event id'),
    /event ID/
  );
});

test('rejects a signed event belonging to another Razorpay account', () => {
  const body = eventBody('acc_Other');
  assert.throws(
    () => verifyRazorpayWebhook(
      body,
      signature(body, currentSecret),
      'event-header-id_123'
    ),
    /account does not match/
  );
});

test('does not invent a timestamp replay check Razorpay signatures do not provide', () => {
  const body = eventBody();
  const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  parsed.created_at = 1;
  const oldBody = Buffer.from(JSON.stringify(parsed));

  assert.doesNotThrow(() => verifyRazorpayWebhook(
    oldBody,
    signature(oldBody, currentSecret),
    'event-header-id_old'
  ));
});
