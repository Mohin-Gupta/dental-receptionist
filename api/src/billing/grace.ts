import { prisma } from '../lib/prisma';
import { BILLING_MANAGED_ENTITLEMENT_SOURCES } from './access';
import { projectVerifiedRazorpaySubscription } from './projection';
import {
  razorpayPathId,
  razorpayRequest,
  type RazorpaySubscriptionEntity,
} from './razorpayClient';

function jsonObject(value: unknown): Record<string, unknown> {
  return value &&
    !Array.isArray(value) &&
    typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function checkoutIntentIdFromPayload(value: unknown): string {
  const checkoutIntentId = jsonObject(value).checkoutIntentId;
  if (
    typeof checkoutIntentId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(checkoutIntentId)
  ) {
    throw new Error(
      'Razorpay cancellation mirror has no valid checkout intent attribution'
    );
  }
  return checkoutIntentId;
}

export async function expireOrganizationBillingGrace(organizationId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${organizationId}`}, 0))::text`;
    const controller = await tx.subscriptionMirror.findFirst({
      where: {
        organizationId,
        activeKey: 'current',
        billingAccount: { activeKey: 'current' },
      },
      select: {
        id: true,
        billingAccountId: true,
        status: true,
        graceUntil: true,
        currentPeriodEnd: true,
      },
    });
    if (!controller) {
      return false;
    }
    const graceExpired = controller.status === 'past_due' &&
      Boolean(controller.graceUntil && controller.graceUntil <= now);
    const completedPeriodExpired = controller.status === 'completed' &&
      Boolean(controller.currentPeriodEnd && controller.currentPeriodEnd <= now);
    if (!graceExpired && !completedPeriodExpired) return false;

    await tx.organization.updateMany({
      where: {
        id: organizationId,
        status: completedPeriodExpired ? 'active' : 'past_due_grace',
      },
      data: { status: completedPeriodExpired ? 'canceled' : 'suspended' },
    });
    if (completedPeriodExpired) {
      await tx.billingAccount.updateMany({
        where: { id: controller.billingAccountId, activeKey: 'current' },
        data: { status: 'completed' },
      });
      await tx.subscriptionMirror.updateMany({
        where: { id: controller.id, activeKey: 'current', status: 'completed' },
        data: { activeKey: null },
      });
    }
    const accessExpiry = completedPeriodExpired
      ? controller.currentPeriodEnd
      : controller.graceUntil;
    await tx.entitlement.updateMany({
      where: {
        organizationId,
        source: { in: [...BILLING_MANAGED_ENTITLEMENT_SOURCES] },
        subscriptionMirrorId: controller.id,
      },
      data: { enabled: false, expiresAt: accessExpiry },
    });
    return true;
  });
}

/** Worker entry point; deliberately not scheduled from the API process. */
export async function expireElapsedBillingGrace(limit = 100, now = new Date()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Grace expiry batch limit must be between 1 and 500');
  }
  const organizations = await prisma.subscriptionMirror.findMany({
    where: {
      activeKey: 'current',
      billingAccount: { activeKey: 'current' },
      OR: [
        { status: 'past_due', graceUntil: { lte: now } },
        { status: 'completed', currentPeriodEnd: { lte: now } },
      ],
    },
    distinct: ['organizationId'],
    select: { organizationId: true },
    take: limit,
  });
  let expired = 0;
  for (const item of organizations) {
    if (await expireOrganizationBillingGrace(item.organizationId, now)) expired += 1;
  }
  return expired;
}

/**
 * Reconciles period-end cancellations after their paid-through timestamp.
 *
 * Razorpay normally sends a terminal subscription webhook at this point. This
 * worker path protects access revocation when that webhook is delayed or lost
 * by retrieving and projecting the provider's canonical subscription object.
 */
export async function reconcileEndedRazorpayCancellations(
  limit = 100,
  now = new Date()
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(
      'Razorpay cancellation reconciliation batch limit must be between 1 and 500'
    );
  }

  const candidates = await prisma.subscriptionMirror.findMany({
    where: {
      billingProvider: 'razorpay',
      activeKey: 'current',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: { lte: now },
      billingAccount: { activeKey: 'current' },
    },
    orderBy: [
      { currentPeriodEnd: 'asc' },
      { id: 'asc' },
    ],
    select: {
      id: true,
      externalSubscriptionId: true,
      providerPayload: true,
    },
    take: limit,
  });

  let projected = 0;
  let terminal = 0;
  const failures: unknown[] = [];

  for (const candidate of candidates) {
    try {
      const checkoutIntentId = checkoutIntentIdFromPayload(
        candidate.providerPayload
      );
      const canonical = await razorpayRequest<RazorpaySubscriptionEntity>(
        'GET',
        `/v1/subscriptions/${razorpayPathId(candidate.externalSubscriptionId)}`
      );
      if (canonical.id !== candidate.externalSubscriptionId) {
        throw new Error(
          'Canonical Razorpay subscription does not match its local mirror'
        );
      }

      const mirror = await projectVerifiedRazorpaySubscription(
        canonical,
        checkoutIntentId
      );
      projected += 1;
      if (mirror.activeKey === null) terminal += 1;
    } catch (error) {
      // Continue the bounded batch so one malformed or unavailable provider
      // record cannot starve other tenants. The aggregate failure below keeps
      // worker health red until every due mirror reconciles successfully.
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const error = new Error(
      `Razorpay cancellation reconciliation failed for ${failures.length} of ${candidates.length} subscriptions`
    ) as Error & { cause?: unknown };
    error.name = 'RazorpayCancellationReconciliationError';
    error.cause = failures[0];
    throw error;
  }

  return {
    examined: candidates.length,
    projected,
    terminal,
  };
}
