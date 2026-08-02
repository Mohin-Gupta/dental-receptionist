import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { prisma } from '../src/lib/prisma';
import * as projection from '../src/billing/projection';
import * as razorpayClient from '../src/billing/razorpayClient';
import {
  reconcileEndedRazorpayCancellations,
} from '../src/billing/grace';
import type { RazorpaySubscriptionEntity } from '../src/billing/razorpayClient';

const checkoutIntentId = '20000000-0000-4000-8000-000000000002';
const subscriptionId = 'sub_PeriodEndCancellation';

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
    plan_id: 'plan_PeriodEnd',
    customer_id: 'cust_PeriodEnd',
    status: 'cancelled',
    current_start: now - 31 * 86_400,
    current_end: now - 86_400,
    ended_at: now - 86_400,
    quantity: 1,
    notes: {
      organizationId: '10000000-0000-4000-8000-000000000001',
      planKey: 'starter',
      checkoutIntentId,
    },
    charge_at: null,
    start_at: now - 31 * 86_400,
    end_at: now - 86_400,
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

test('reconciles only bounded due period-end Razorpay cancellations', async context => {
  const canonical = cancelledSubscription();
  const requestedPaths: string[] = [];
  const projected: Array<{ subscriptionId: string; intentId: string }> = [];
  const now = new Date('2026-07-29T12:00:00.000Z');

  replaceMethod(
    context,
    prisma.subscriptionMirror as unknown as Record<PropertyKey, unknown>,
    'findMany',
    async (args: Record<string, any>) => {
      assert.deepEqual(args.where, {
        billingProvider: 'razorpay',
        activeKey: 'current',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { lte: now },
        billingAccount: { activeKey: 'current' },
      });
      assert.equal(args.take, 25);
      return [{
        id: '40000000-0000-4000-8000-000000000004',
        externalSubscriptionId: subscriptionId,
        providerPayload: { checkoutIntentId },
      }];
    }
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async (method: string, path: string) => {
      assert.equal(method, 'GET');
      requestedPaths.push(path);
      return canonical;
    }
  );
  replaceMethod(
    context,
    projection as unknown as Record<PropertyKey, unknown>,
    'projectVerifiedRazorpaySubscription',
    async (subscription: RazorpaySubscriptionEntity, intentId: string) => {
      projected.push({ subscriptionId: subscription.id, intentId });
      return { activeKey: null };
    }
  );

  const result = await reconcileEndedRazorpayCancellations(25, now);

  assert.deepEqual(requestedPaths, [
    `/v1/subscriptions/${subscriptionId}`,
  ]);
  assert.deepEqual(projected, [{
    subscriptionId,
    intentId: checkoutIntentId,
  }]);
  assert.deepEqual(result, {
    examined: 1,
    projected: 1,
    terminal: 1,
  });
});

test('fails closed without provider access when checkout attribution is missing', async context => {
  let providerCalls = 0;

  replaceMethod(
    context,
    prisma.subscriptionMirror as unknown as Record<PropertyKey, unknown>,
    'findMany',
    async () => [{
      id: '40000000-0000-4000-8000-000000000004',
      externalSubscriptionId: subscriptionId,
      providerPayload: {},
    }]
  );
  replaceMethod(
    context,
    razorpayClient as unknown as Record<PropertyKey, unknown>,
    'razorpayRequest',
    async () => {
      providerCalls += 1;
      return cancelledSubscription();
    }
  );

  await assert.rejects(
    () => reconcileEndedRazorpayCancellations(),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'RazorpayCancellationReconciliationError' &&
      /failed for 1 of 1/.test(error.message)
  );
  assert.equal(providerCalls, 0);
});

test('rejects invalid reconciliation batch limits', async () => {
  await assert.rejects(
    () => reconcileEndedRazorpayCancellations(0),
    /batch limit must be between 1 and 500/
  );
  await assert.rejects(
    () => reconcileEndedRazorpayCancellations(501),
    /batch limit must be between 1 and 500/
  );
});
