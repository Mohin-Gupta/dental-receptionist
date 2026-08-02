import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import {
  RazorpayApiError,
  razorpayHasPendingSubscriptionUpdate,
  razorpayRequest,
  verifyRazorpayCheckoutSignature,
} from '../src/billing/razorpayClient';

const ENV_KEYS = [
  'NODE_ENV',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_EXPECT_KEY_MODE',
  'RAZORPAY_API_BASE_URL',
  'RAZORPAY_API_TIMEOUT_MS',
  'RAZORPAY_API_MAX_RETRIES',
] as const;
const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
const originalFetch = globalThis.fetch;
const keySecret = 'unit_test_key_secret_long_enough';

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_UnitTest';
  process.env.RAZORPAY_KEY_SECRET = keySecret;
  process.env.RAZORPAY_EXPECT_KEY_MODE = 'test';
  process.env.RAZORPAY_API_BASE_URL = 'https://razorpay.test';
  process.env.RAZORPAY_API_TIMEOUT_MS = '1000';
  process.env.RAZORPAY_API_MAX_RETRIES = '1';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('uses HTTP Basic authentication and JSON for Razorpay requests', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.toString(), 'https://razorpay.test/v1/subscriptions');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Basic ${Buffer.from(`rzp_test_UnitTest:${keySecret}`).toString('base64')}`
    );
    assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.equal(init?.body, JSON.stringify({ plan_id: 'plan_UnitTest' }));
    return new Response(JSON.stringify({ id: 'sub_UnitTest' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await razorpayRequest<{ id: string }>('POST', '/v1/subscriptions', {
    body: { plan_id: 'plan_UnitTest' },
  });
  assert.equal(result.id, 'sub_UnitTest');
});

test('retries a safe GET after a transient provider response', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({
        error: { code: 'SERVER_ERROR', description: 'temporary' },
      }), { status: 503, headers: { 'retry-after': '0' } });
    }
    return new Response(JSON.stringify({ id: 'plan_UnitTest' }), { status: 200 });
  };

  const result = await razorpayRequest<{ id: string }>(
    'GET',
    '/v1/plans/plan_UnitTest'
  );
  assert.equal(result.id, 'plan_UnitTest');
  assert.equal(attempts, 2);
});

test('does not blindly retry a financially mutating POST', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({
      error: { code: 'SERVER_ERROR', description: 'unknown provider outcome' },
    }), { status: 503 });
  };

  await assert.rejects(
    () => razorpayRequest('POST', '/v1/subscriptions', {
      body: { plan_id: 'plan_UnitTest' },
    }),
    (error: unknown) =>
      error instanceof RazorpayApiError &&
      error.retryable &&
      /unknown provider outcome/.test(error.message)
  );
  assert.equal(attempts, 1);
});

test('distinguishes a pending subscription update from a cycle-end cancellation', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'sub_UnitTest',
    entity: 'subscription',
    has_scheduled_changes: true,
  }), { status: 200 });

  assert.equal(
    await razorpayHasPendingSubscriptionUpdate('sub_UnitTest'),
    true
  );
});

test('accepts only Razorpay documented no-pending-update response as absence', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: 'BAD_REQUEST_ERROR',
      description: 'No Pending update for this subscription.',
    },
  }), { status: 400 });

  assert.equal(
    await razorpayHasPendingSubscriptionUpdate('sub_UnitTest'),
    false
  );

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: 'BAD_REQUEST_ERROR',
      description: 'The id provided is invalid or could not be found.',
    },
  }), { status: 400 });

  await assert.rejects(
    () => razorpayHasPendingSubscriptionUpdate('sub_UnitTest'),
    (error: unknown) =>
      error instanceof RazorpayApiError &&
      /invalid or could not be found/i.test(error.message)
  );
});

test('verifies checkout success against the server-stored subscription ID', () => {
  const paymentId = 'pay_UnitTest';
  const expectedSubscriptionId = 'sub_ServerStored';
  const signature = crypto
    .createHmac('sha256', keySecret)
    .update(`${paymentId}|${expectedSubscriptionId}`)
    .digest('hex');

  assert.equal(verifyRazorpayCheckoutSignature({
    paymentId,
    expectedSubscriptionId,
    signature,
  }), true);
  assert.equal(verifyRazorpayCheckoutSignature({
    paymentId,
    expectedSubscriptionId: 'sub_ClientSubstitution',
    signature,
  }), false);
});
