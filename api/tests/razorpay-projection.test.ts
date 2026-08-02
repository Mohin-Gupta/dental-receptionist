import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';
import { prisma } from '../src/lib/prisma';
import * as razorpayClient from '../src/billing/razorpayClient';
import { processRazorpayEvent } from '../src/billing/projection';
import type {
  RazorpaySubscriptionEntity,
} from '../src/billing/razorpayClient';
import type { RazorpayWebhookEvent } from '../src/billing/razorpayWebhook';

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
const mirrorId = '40000000-0000-4000-8000-000000000004';
const planId = 'plan_00000000000001';
const subscriptionId = 'sub_CanonicalWatermark';

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

function cancelledSubscription(): RazorpaySubscriptionEntity {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id: subscriptionId,
    entity: 'subscription',
    plan_id: planId,
    customer_id: 'cust_CanonicalWatermark',
    status: 'cancelled',
    current_start: now - 31 * 86_400,
    current_end: now - 86_400,
    ended_at: now - 60,
    quantity: 1,
    notes: {
      organizationId,
      planKey: 'starter',
      checkoutIntentId,
    },
    charge_at: null,
    start_at: now - 31 * 86_400,
    end_at: now - 60,
    auth_attempts: 1,
    total_count: 120,
    paid_count: 1,
    customer_notify: true,
    created_at: now - 31 * 86_400,
    expire_by: null,
    short_url: null,
    has_scheduled_changes: false,
    remaining_count: 119,
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_ProjectionTests';
  process.env.RAZORPAY_KEY_SECRET = 'unit_test_projection_secret_long_enough';
  process.env.RAZORPAY_EXPECT_KEY_MODE = 'test';
  process.env.RAZORPAY_PLAN_CONFIG_JSON = JSON.stringify({
    starter: {
      currency: 'INR',
      planId,
      amountMinor: 49_900,
      period: 'monthly',
      interval: 1,
      quantity: 1,
      totalCount: 120,
      customerNotify: true,
      entitlements: { 'appointments.write': true },
      trialDays: 0,
    },
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('applies a fresh canonical state even when the triggering event predates the watermark', async context => {
  const eventCreated = new Date('2026-07-29T11:55:00.000Z');
  const existingWatermark = new Date('2026-07-29T12:00:00.000Z');
  const updatedAt = new Date('2026-07-29T12:00:01.000Z');
  const canonical = cancelledSubscription();
  const intent = {
    id: checkoutIntentId,
    organizationId,
    billingAccountId,
    billingProvider: 'razorpay',
    requestKeyHash: 'request-hash',
    planKey: 'starter',
    status: 'completed',
    activeKey: null,
    externalSessionId: subscriptionId,
    externalPaymentId: 'pay_CanonicalWatermark',
    sessionUrlCiphertext: null,
    expiresAt: new Date('2026-07-29T13:00:00.000Z'),
    checkoutVerifiedAt: new Date('2026-07-29T11:00:00.000Z'),
    completedAt: new Date('2026-07-29T11:00:00.000Z'),
    lastError: null,
    createdAt: new Date('2026-07-29T10:59:00.000Z'),
    updatedAt,
  };
  const account = {
    id: billingAccountId,
    organizationId,
    billingProvider: 'razorpay',
    activeKey: 'current',
    externalCustomerId: null,
    status: 'active',
    billingEmail: 'billing@example.test',
    currency: 'INR',
    taxIds: null,
    billingAddress: null,
    metadata: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt,
  };
  const existing = {
    id: mirrorId,
    organizationId,
    billingAccountId,
    billingProvider: 'razorpay',
    externalSubscriptionId: subscriptionId,
    planKey: 'starter',
    status: 'active',
    providerStatus: 'active',
    activeKey: 'current',
    currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    graceUntil: null,
    providerPayload: { checkoutIntentId },
    lastProviderEventId: 'newer-trigger',
    lastProviderEventCreatedAt: existingWatermark,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt,
  };
  let canonicalReads = 0;
  let mirrorUpdate: Record<string, any> | null = null;
  let organizationUpdate: Record<string, any> | null = null;
  const entitlementUpdates: Array<Record<string, any>> = [];

  replaceMethod(
    context,
    prisma.billingCheckoutSession as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async () => intent
  );
  replaceMethod(
    context,
    prisma.subscriptionMirror as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async () => existing
  );
  replaceMethod(
    context,
    prisma.billingAccount as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async () => account
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async () => {
      canonicalReads += 1;
      return canonical;
    }
  );
  replaceMethod(
    context,
    prisma as unknown as Record<PropertyKey, unknown>,
    '$transaction',
    async (operation: (tx: Record<string, any>) => Promise<unknown>) =>
      operation({
        $queryRaw: async () => [],
        subscriptionMirror: {
          findUnique: async () => existing,
          findFirst: async () => null,
          upsert: async (args: Record<string, any>) => {
            mirrorUpdate = args.update;
            return {
              ...existing,
              ...args.update,
            };
          },
        },
        billingCheckoutSession: {
          findUnique: async () => intent,
          updateMany: async () => ({ count: 0 }),
          update: async () => intent,
        },
        billingAccount: {
          update: async () => account,
        },
        organization: {
          update: async (args: Record<string, any>) => {
            organizationUpdate = args.data;
            return { id: organizationId, ...args.data };
          },
        },
        entitlement: {
          deleteMany: async () => ({ count: 0 }),
          upsert: async (args: Record<string, any>) => {
            entitlementUpdates.push(args.update);
            return args.update;
          },
        },
      })
  );

  const event = {
    entity: 'event',
    account_id: 'acc_ProjectionTests',
    event: 'subscription.cancelled',
    contains: ['subscription'],
    payload: {
      subscription: {
        entity: {
          id: subscriptionId,
          notes: canonical.notes,
        },
      },
    },
    created_at: Math.floor(eventCreated.getTime() / 1_000),
  } as unknown as RazorpayWebhookEvent;

  const result = await processRazorpayEvent(event, 'older-trigger');
  const capturedMirrorUpdate = mirrorUpdate as Record<string, any> | null;
  const capturedOrganizationUpdate =
    organizationUpdate as Record<string, any> | null;

  assert.equal(canonicalReads, 1);
  assert.equal(result.organizationId, organizationId);
  assert.equal(capturedMirrorUpdate?.status, 'canceled');
  assert.equal(capturedMirrorUpdate?.providerStatus, 'cancelled');
  assert.equal(capturedMirrorUpdate?.activeKey, null);
  assert.equal(
    capturedMirrorUpdate?.lastProviderEventCreatedAt,
    existingWatermark
  );
  assert.equal(capturedMirrorUpdate?.lastProviderEventId, 'newer-trigger');
  assert.equal(capturedOrganizationUpdate?.status, 'canceled');
  assert.equal(entitlementUpdates[0]?.enabled, false);
});
