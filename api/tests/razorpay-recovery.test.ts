import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';
import {
  Prisma,
  type BillingCancellationAttempt,
  type SubscriptionMirror,
} from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import * as projection from '../src/billing/projection';
import * as razorpayClient from '../src/billing/razorpayClient';
import {
  cancelRazorpaySubscription,
  reconcilePendingRazorpayCancellations,
  reconcileStaleRazorpayCheckoutSessions,
} from '../src/billing/checkout';
import type {
  RazorpaySubscriptionEntity,
  RazorpaySubscriptionStatus,
} from '../src/billing/razorpayClient';

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
const userId = '50000000-0000-4000-8000-000000000005';
const planId = 'plan_00000000000001';
const subscriptionId = 'sub_RecoveryTests';

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

function subscription(
  status: RazorpaySubscriptionStatus,
  scheduledCancellation = false
): RazorpaySubscriptionEntity {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id: subscriptionId,
    entity: 'subscription',
    plan_id: planId,
    customer_id: 'cust_RecoveryTests',
    status,
    current_start: now - 10 * 86_400,
    current_end: now + 20 * 86_400,
    ended_at: status === 'cancelled' ? now : null,
    quantity: 1,
    notes: {
      organizationId,
      planKey: 'starter',
      checkoutIntentId,
    },
    charge_at: now + 20 * 86_400,
    start_at: now - 10 * 86_400,
    end_at: now + 110 * 30 * 86_400,
    auth_attempts: 1,
    total_count: 120,
    paid_count: 10,
    customer_notify: true,
    created_at: now - 10 * 86_400,
    expire_by: null,
    short_url: null,
    has_scheduled_changes: scheduledCancellation,
    change_scheduled_at: scheduledCancellation ? now : null,
    schedule_change_at: scheduledCancellation ? 'cycle_end' : null,
    remaining_count: 110,
  };
}

function mirror(
  providerPayload: Prisma.JsonObject,
  overrides: Partial<SubscriptionMirror> = {}
): SubscriptionMirror {
  const now = new Date();
  return {
    id: mirrorId,
    organizationId,
    billingAccountId,
    billingProvider: 'razorpay',
    externalSubscriptionId: subscriptionId,
    planKey: 'starter',
    status: 'active',
    providerStatus: 'active',
    activeKey: 'current',
    currentPeriodStart: new Date(now.getTime() - 10 * 86_400_000),
    currentPeriodEnd: new Date(now.getTime() + 20 * 86_400_000),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    graceUntil: null,
    providerPayload,
    lastProviderEventId: 'subscription.activated',
    lastProviderEventCreatedAt: new Date(now.getTime() - 10 * 86_400_000),
    createdAt: new Date(now.getTime() - 10 * 86_400_000),
    updatedAt: new Date(now.getTime() - 10 * 60_000),
    ...overrides,
  };
}

function submittingPayload(
  requestedAt: Date,
  mode: 'immediate' | 'period_end' = 'period_end'
) {
  return {
    checkoutIntentId,
    cancellationRequestHash: 'a'.repeat(64),
    cancellationRequestedByUserId: userId,
    cancellationMode: mode,
    cancellationStatus: 'submitting',
    cancellationRequestedAt: requestedAt.toISOString(),
  };
}

function cancellationAttempt(
  requestedAt: Date,
  overrides: Partial<BillingCancellationAttempt> = {}
): BillingCancellationAttempt {
  return {
    id: '60000000-0000-4000-8000-000000000006',
    organizationId,
    subscriptionMirrorId: mirrorId,
    billingProvider: 'razorpay',
    requestHash: 'a'.repeat(64),
    requestedByUserId: userId,
    mode: 'period_end',
    status: 'submitting',
    activeKey: 'active',
    requestedAt,
    confirmedAt: null,
    nextAttemptAt: requestedAt,
    processingStartedAt: null,
    leaseToken: null,
    attempts: 0,
    lastError: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_RecoveryTests';
  process.env.RAZORPAY_KEY_SECRET = 'unit_test_recovery_secret_long_enough';
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

test('projects an authorized subscription when the browser callback was lost', async context => {
  const now = new Date();
  const canonical = subscription('authenticated');
  const intent = {
    id: checkoutIntentId,
    organizationId,
    billingAccountId,
    billingProvider: 'razorpay',
    requestKeyHash: 'request-hash',
    planKey: 'starter',
    status: 'open',
    activeKey: 'active',
    externalSessionId: subscriptionId,
    externalPaymentId: null,
    sessionUrlCiphertext: null,
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    checkoutVerifiedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: new Date(now.getTime() - 20 * 60_000),
    updatedAt: new Date(now.getTime() - 10 * 60_000),
  };
  let selection: Record<string, any> | null = null;
  const updates: Array<Record<string, any>> = [];
  const projected: Array<{ subscriptionId: string; intentId: string }> = [];

  replaceMethod(
    context,
    prisma.billingCheckoutSession as unknown as Record<PropertyKey, unknown>,
    'findMany',
    async (args: Record<string, any>) => {
      selection = args;
      return [intent];
    }
  );
  replaceMethod(
    context,
    prisma.billingCheckoutSession as unknown as Record<PropertyKey, unknown>,
    'updateMany',
    async (args: Record<string, any>) => {
      updates.push(args);
      return { count: 1 };
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
      billingAccounts: [],
    })
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async (method: string, path: string) => {
      assert.equal(method, 'GET');
      assert.equal(path, `/v1/subscriptions/${subscriptionId}`);
      return canonical;
    }
  );
  replaceMethod(
    context,
    projection as unknown as Record<PropertyKey, unknown>,
    'projectVerifiedRazorpaySubscription',
    async (providerSubscription: RazorpaySubscriptionEntity, intentId: string) => {
      projected.push({
        subscriptionId: providerSubscription.id,
        intentId,
      });
      return { status: 'active' };
    }
  );

  const result = await reconcileStaleRazorpayCheckoutSessions(25, now);
  const capturedSelection = selection as Record<string, any> | null;

  assert.equal(capturedSelection?.take, 25);
  assert.equal(capturedSelection?.where.billingProvider, 'razorpay');
  assert.equal(capturedSelection?.where.activeKey, 'active');
  assert.deepEqual(
    capturedSelection?.where.updatedAt,
    { lte: new Date(now.getTime() - 5 * 60_000) }
  );
  assert.deepEqual(projected, [{
    subscriptionId,
    intentId: checkoutIntentId,
  }]);
  assert.equal(updates[0].data.status, 'verified');
  assert.equal(updates[1].data.updatedAt, now);
  assert.deepEqual(result, {
    examined: 1,
    stillPending: 0,
  });
});

test('confirms an ambiguous period-end cancellation from canonical provider state', async context => {
  const now = new Date();
  const current = mirror(submittingPayload(new Date(now.getTime() - 60_000)));
  const queuedAttempt = cancellationAttempt(
    new Date(now.getTime() - 60_000)
  );
  const canonical = subscription('active', true);
  let mirrorUpdate: Record<string, any> | null = null;
  let pendingUpdateChecks = 0;
  let claimedAttempt: BillingCancellationAttempt | null = null;
  let candidateReturned = false;

  replaceMethod(
    context,
    prisma.billingCancellationAttempt as unknown as Record<PropertyKey, unknown>,
    'findFirst',
    async (args: Record<string, any>) => {
      if (args.where.leaseToken) return claimedAttempt;
      if (candidateReturned) return null;
      candidateReturned = true;
      return queuedAttempt;
    }
  );
  replaceMethod(
    context,
    prisma.billingCancellationAttempt as unknown as Record<PropertyKey, unknown>,
    'updateMany',
    async (args: Record<string, any>) => {
      claimedAttempt = {
        ...queuedAttempt,
        status: 'processing',
        processingStartedAt: args.data.processingStartedAt,
        leaseToken: args.data.leaseToken,
        nextAttemptAt: null,
        attempts: queuedAttempt.attempts + 1,
      };
      return { count: 1 };
    }
  );
  replaceMethod(
    context,
    prisma.subscriptionMirror as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async () => current
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async (method: string, path: string) => {
      assert.equal(method, 'GET');
      assert.equal(path, `/v1/subscriptions/${subscriptionId}`);
      return canonical;
    }
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayHasPendingSubscriptionUpdate',
    async () => {
      pendingUpdateChecks += 1;
      return false;
    }
  );
  replaceMethod(
    context,
    prisma as unknown as Record<PropertyKey, unknown>,
    '$transaction',
    async (operation: (tx: Record<string, any>) => Promise<unknown>) =>
      operation({
        $queryRaw: async () => [],
        billingCancellationAttempt: {
          findUnique: async () => claimedAttempt,
          findFirst: async () => null,
          updateMany: async () => ({ count: 1 }),
        },
        subscriptionMirror: {
          findUnique: async () => current,
          findFirst: async () => null,
          update: async (args: Record<string, any>) => {
            mirrorUpdate = args.data;
            return { ...current, ...args.data };
          },
        },
        billingAccount: {
          findFirst: async () => ({ id: billingAccountId }),
          update: async () => ({ id: billingAccountId }),
        },
        organization: {
          update: async () => ({ id: organizationId }),
        },
        entitlement: {
          updateMany: async () => ({ count: 0 }),
        },
      })
  );

  const result = await reconcilePendingRazorpayCancellations(10, now);
  const capturedMirrorUpdate = mirrorUpdate as Record<string, any> | null;

  assert.equal(pendingUpdateChecks, 1);
  assert.equal(capturedMirrorUpdate?.cancelAtPeriodEnd, true);
  assert.equal(capturedMirrorUpdate?.activeKey, 'current');
  assert.equal(
    capturedMirrorUpdate?.providerPayload.cancellationStatus,
    'confirmed'
  );
  assert.match(
    capturedMirrorUpdate?.providerPayload.cancellationConfirmedAt,
    /^\d{4}-\d{2}-\d{2}T/
  );
  assert.deepEqual(result, {
    examined: 1,
    confirmed: 1,
    failed: 0,
    pending: 0,
  });
});

test('keeps an ambiguous cancellation reusable after its reconciliation timeout', async context => {
  const now = new Date();
  const requestedAt = new Date(now.getTime() - 10 * 60_000);
  const current = mirror(
    submittingPayload(requestedAt)
  );
  const queuedAttempt = cancellationAttempt(requestedAt);
  const canonical = subscription('active');
  let claimedAttempt: BillingCancellationAttempt | null = null;
  let candidateReturned = false;
  const attemptUpdates: Array<Record<string, any>> = [];

  replaceMethod(
    context,
    prisma.billingCancellationAttempt as unknown as Record<PropertyKey, unknown>,
    'findFirst',
    async (args: Record<string, any>) => {
      if (args.where.leaseToken) return claimedAttempt;
      if (candidateReturned) return null;
      candidateReturned = true;
      return queuedAttempt;
    }
  );
  replaceMethod(
    context,
    prisma.billingCancellationAttempt as unknown as Record<PropertyKey, unknown>,
    'updateMany',
    async (args: Record<string, any>) => {
      attemptUpdates.push(args);
      if (args.data.status === 'processing') {
        claimedAttempt = {
          ...queuedAttempt,
          status: 'processing',
          processingStartedAt: args.data.processingStartedAt,
          leaseToken: args.data.leaseToken,
          nextAttemptAt: null,
          attempts: queuedAttempt.attempts + 1,
        };
      }
      return { count: 1 };
    }
  );
  replaceMethod(
    context,
    prisma.subscriptionMirror as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async () => current
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async () => canonical
  );
  const result = await reconcilePendingRazorpayCancellations(10, now);
  const release = attemptUpdates[1];

  assert.equal(release.data.status, 'submitting');
  assert.equal(release.data.activeKey, undefined);
  assert.equal(release.data.processingStartedAt, null);
  assert.equal(release.data.leaseToken, null);
  assert.ok(release.data.nextAttemptAt > now);
  assert.match(
    release.data.lastError,
    /operator review is required/
  );
  assert.deepEqual(result, {
    examined: 1,
    confirmed: 0,
    failed: 0,
    pending: 1,
  });
});

test('replays an old cancellation through the indexed attempt lookup', async context => {
  let lookup: Record<string, any> | null = null;
  let providerCalls = 0;
  let lookupCalls = 0;

  replaceMethod(
    context,
    prisma.billingCancellationAttempt as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async (args: Record<string, any>) => {
      lookupCalls += 1;
      lookup = args;
      const requestHash =
        args.where.organizationId_billingProvider_requestHash.requestHash;
      return cancellationAttempt(new Date('2024-01-01T00:00:00.000Z'), {
        requestHash,
        mode: 'immediate',
        status: 'confirmed',
        activeKey: null,
        confirmedAt: new Date('2024-01-01T00:00:01.000Z'),
        nextAttemptAt: null,
      });
    }
  );
  replaceMethod(
    context,
    prisma.subscriptionMirror as unknown as Record<PropertyKey, unknown>,
    'findUnique',
    async () => mirror(
      {
        checkoutIntentId,
        cancellationRequestHash: 'a'.repeat(64),
        cancellationRequestedByUserId: userId,
        cancellationMode: 'immediate',
        cancellationStatus: 'confirmed',
        cancellationRequestedAt: '2024-01-01T00:00:00.000Z',
        cancellationConfirmedAt: '2024-01-01T00:00:01.000Z',
      },
      {
        status: 'canceled',
        providerStatus: 'cancelled',
        activeKey: null,
        canceledAt: new Date('2024-01-01T00:00:01.000Z'),
        updatedAt: new Date('2024-01-01T00:00:01.000Z'),
      }
    )
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async () => {
      providerCalls += 1;
      return subscription('cancelled');
    }
  );

  const result = await cancelRazorpaySubscription(
    organizationId,
    'old-cancellation-idempotency-key',
    userId
  );
  const capturedLookup = lookup as Record<string, any> | null;

  assert.equal(lookupCalls, 1);
  assert.equal(providerCalls, 0);
  assert.deepEqual(capturedLookup?.where, {
    organizationId_billingProvider_requestHash: {
      organizationId,
      billingProvider: 'razorpay',
      requestHash:
        capturedLookup?.where.organizationId_billingProvider_requestHash.requestHash,
    },
  });
  assert.match(
    capturedLookup?.where.organizationId_billingProvider_requestHash.requestHash,
    /^[a-f0-9]{64}$/
  );
  assert.equal(result.cancellationMode, 'immediate');
  assert.equal(result.cancelAtPeriodEnd, false);
});
