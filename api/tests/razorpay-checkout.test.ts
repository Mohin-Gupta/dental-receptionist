import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { prisma } from '../src/lib/prisma';
import * as projection from '../src/billing/projection';
import * as razorpayClient from '../src/billing/razorpayClient';
import {
  BillingConflictError,
  createRazorpayCheckoutSession,
  verifyRazorpayCheckout,
} from '../src/billing/checkout';
import type { RazorpaySubscriptionEntity } from '../src/billing/razorpayClient';

const ENV_KEYS = [
  'NODE_ENV',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_EXPECT_KEY_MODE',
  'RAZORPAY_PLAN_CONFIG_JSON',
] as const;
const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

const organizationId = '10000000-0000-4000-8000-000000000001';
const checkoutIntentId = '20000000-0000-4000-8000-000000000002';
const billingAccountId = '30000000-0000-4000-8000-000000000003';
const planId = 'plan_00000000000001';
const subscriptionId = 'sub_CompletedRecovery';
const keySecret = 'unit_test_checkout_secret_long_enough';

const configuredPlan = {
  currency: 'INR',
  planId,
  amountMinor: 49_900,
  period: 'monthly',
  interval: 1,
  quantity: 1,
  totalCount: 120,
  customerNotify: true,
  name: 'Starter',
  entitlements: { 'appointments.write': true },
  trialDays: 0,
};

function replaceMethod(
  context: { after(cleanup: () => unknown): void },
  target: Record<PropertyKey, unknown>,
  method: PropertyKey,
  replacement: (...args: any[]) => any
): void {
  const original = target[method];
  target[method] = replacement;
  context.after(() => {
    target[method] = original;
  });
}

function completedSubscription(): RazorpaySubscriptionEntity {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id: subscriptionId,
    entity: 'subscription',
    plan_id: planId,
    customer_id: 'cust_CompletedRecovery',
    status: 'completed',
    current_start: now - 3_600,
    current_end: now + 30 * 86_400,
    ended_at: null,
    quantity: 1,
    notes: {
      organizationId,
      planKey: 'starter',
      checkoutIntentId,
    },
    charge_at: null,
    start_at: now - 3_600,
    end_at: now + 30 * 86_400,
    auth_attempts: 1,
    total_count: 120,
    paid_count: 120,
    customer_notify: true,
    created_at: now - 7_200,
    expire_by: now + 3_600,
    short_url: null,
    has_scheduled_changes: false,
    remaining_count: 0,
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_CheckoutTests';
  process.env.RAZORPAY_KEY_SECRET = keySecret;
  process.env.RAZORPAY_EXPECT_KEY_MODE = 'test';
  process.env.RAZORPAY_PLAN_CONFIG_JSON = JSON.stringify({
    starter: configuredPlan,
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('checkout recovery treats a completed provider subscription as authorized', async context => {
  const subscription = completedSubscription();
  const account = {
    id: billingAccountId,
    organizationId,
    billingProvider: 'razorpay',
    activeKey: 'current',
    externalCustomerId: null,
    status: 'pending',
    billingEmail: 'billing@example.test',
    currency: 'INR',
    taxIds: null,
    billingAddress: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const intent = {
    id: checkoutIntentId,
    organizationId,
    billingAccountId,
    billingProvider: 'razorpay',
    requestKeyHash: 'request-hash',
    planKey: 'starter',
    status: 'creating',
    activeKey: 'active',
    externalSessionId: null,
    externalPaymentId: null,
    sessionUrlCiphertext: null,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    checkoutVerifiedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: new Date(Date.now() - 10_000),
    updatedAt: new Date(Date.now() - 10_000),
  };
  const checkoutUpdates: Array<Record<string, any>> = [];
  const projected: Array<{ subscriptionId: string; intentId: string }> = [];

  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async (_method: string, path: string) => {
      if (path.startsWith('/v1/plans/')) {
        return {
          id: planId,
          entity: 'plan',
          interval: 1,
          period: 'monthly',
          item: {
            id: 'item_00000000000001',
            active: true,
            name: 'Starter',
            description: null,
            amount: configuredPlan.amountMinor,
            currency: configuredPlan.currency,
          },
          notes: [],
          created_at: Math.floor(Date.now() / 1_000),
        };
      }
      assert.equal(path, '/v1/subscriptions');
      return {
        entity: 'collection',
        count: 1,
        items: [subscription],
      };
    }
  );
  replaceMethod(
    context,
    projection as unknown as Record<PropertyKey, unknown>,
    'projectVerifiedRazorpaySubscription',
    async (canonical: RazorpaySubscriptionEntity, intentId: string) => {
      projected.push({ subscriptionId: canonical.id, intentId });
      return { status: 'completed' };
    }
  );
  replaceMethod(
    context,
    prisma.organization as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async () => ({
      id: organizationId,
      name: 'Example Dental',
      email: 'billing@example.test',
      phone: null,
      billingAccounts: [account],
    })
  );
  replaceMethod(
    context,
    prisma as unknown as Record<PropertyKey, unknown>,
    '$transaction',
    async (operation: (tx: Record<string, any>) => Promise<unknown>) => operation({
      $queryRaw: async () => [],
      organization: {
        findUnique: async () => ({
          id: organizationId,
          email: 'billing@example.test',
        }),
      },
      billingAccount: {
        findMany: async () => [account],
      },
    })
  );
  replaceMethod(
    context,
    prisma.billingCheckoutSession as unknown as Record<PropertyKey, unknown>,
    'findFirst',
    async () => intent
  );
  replaceMethod(
    context,
    prisma.billingCheckoutSession as unknown as Record<PropertyKey, unknown>,
    'updateMany',
    async (args: Record<string, any>) => {
      checkoutUpdates.push(args);
      return { count: 1 };
    }
  );

  await assert.rejects(
    () => createRazorpayCheckoutSession({
      organizationId,
      planKey: 'starter',
      requestIdempotencyKey: 'completed-recovery-key',
    }),
    (error: unknown) =>
      error instanceof BillingConflictError &&
      /already active/.test(error.message)
  );

  assert.deepEqual(projected, [{
    subscriptionId,
    intentId: checkoutIntentId,
  }]);
  assert.equal(checkoutUpdates.length, 1);
  assert.equal(checkoutUpdates[0].data.status, 'verified');
  assert.equal(checkoutUpdates[0].data.externalSessionId, subscriptionId);
  assert.equal(checkoutUpdates[0].data.activeKey, undefined);
});

test('verification fills the payment ID after a webhook completed the intent first', async context => {
  const paymentId = 'pay_WebhookWonRace';
  const signature = crypto
    .createHmac('sha256', keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  const updateCalls: Array<Record<string, any>> = [];

  replaceMethod(
    context,
    prisma.billingCheckoutSession as unknown as Record<PropertyKey, unknown>,
    'findFirst',
    async () => ({
      id: checkoutIntentId,
      organizationId,
      billingAccountId,
      billingProvider: 'razorpay',
      requestKeyHash: 'request-hash',
      planKey: 'starter',
      status: 'completed',
      activeKey: null,
      externalSessionId: subscriptionId,
      externalPaymentId: null,
      sessionUrlCiphertext: null,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      checkoutVerifiedAt: null,
      completedAt: new Date(),
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );
  replaceMethod(
    context,
    prisma.billingCheckoutSession as unknown as Record<PropertyKey, unknown>,
    'updateMany',
    async (args: Record<string, any>) => {
      updateCalls.push(args);
      return {
        count: args.where.status === 'completed' ? 1 : 0,
      };
    }
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async () => completedSubscription()
  );
  replaceMethod(
    context,
    projection as unknown as Record<PropertyKey, unknown>,
    'projectVerifiedRazorpaySubscription',
    async () => ({ status: 'completed' })
  );

  const result = await verifyRazorpayCheckout({
    organizationId,
    checkoutIntentId,
    razorpayPaymentId: paymentId,
    razorpaySubscriptionId: subscriptionId,
    razorpaySignature: signature,
  });

  assert.equal(result.accepted, true);
  assert.equal(updateCalls.length, 2);
  assert.deepEqual(updateCalls[1].where, {
    id: checkoutIntentId,
    status: 'completed',
    externalSessionId: subscriptionId,
    externalPaymentId: null,
  });
  assert.equal(updateCalls[1].data.externalPaymentId, paymentId);
  assert.ok(updateCalls[1].data.checkoutVerifiedAt instanceof Date);
});
