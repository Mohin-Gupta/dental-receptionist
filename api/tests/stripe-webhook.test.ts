import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { StripeWebhookError, verifyStripeWebhook } from '../src/billing/stripeWebhook';

const ENV_KEYS = [
  'NODE_ENV',
  'WEB_ORIGIN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRETS',
  'STRIPE_EXPECT_LIVEMODE',
  'STRIPE_WEBHOOK_TOLERANCE_SECONDS',
] as const;
const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function eventBody(livemode = false): Buffer {
  return Buffer.from(JSON.stringify({
    id: 'evt_UnitTest',
    type: 'invoice.paid',
    created: Math.floor(Date.now() / 1_000),
    livemode,
    data: { object: { id: 'in_UnitTest' } },
  }));
}

function signature(body: Buffer, secret: string, timestamp = Math.floor(Date.now() / 1_000)) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  process.env.STRIPE_SECRET_KEY = 'sk_test_UnitTest';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_current';
  process.env.STRIPE_WEBHOOK_SECRETS = 'whsec_previous';
  process.env.STRIPE_EXPECT_LIVEMODE = 'false';
  process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS = '300';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('accepts an exact raw payload signed by an overlapping rotation secret', () => {
  const body = eventBody();
  const event = verifyStripeWebhook(body, signature(body, 'whsec_previous'));
  assert.equal(event.id, 'evt_UnitTest');
});

test('rejects a body changed after the provider signed it', () => {
  const body = eventBody();
  const header = signature(body, 'whsec_current');
  const changed = Buffer.from(body.toString('utf8').replace('invoice.paid', 'invoice.voided'));

  assert.throws(
    () => verifyStripeWebhook(changed, header),
    (error: unknown) => error instanceof StripeWebhookError && /signature/.test(error.message)
  );
});

test('rejects signatures outside the replay window', () => {
  const body = eventBody();
  const oldTimestamp = Math.floor(Date.now() / 1_000) - 301;

  assert.throws(
    () => verifyStripeWebhook(body, signature(body, 'whsec_current', oldTimestamp)),
    /replay window/
  );
});

test('rejects live events in a test-mode deployment', () => {
  const body = eventBody(true);

  assert.throws(
    () => verifyStripeWebhook(body, signature(body, 'whsec_current')),
    /mode does not match/
  );
});
