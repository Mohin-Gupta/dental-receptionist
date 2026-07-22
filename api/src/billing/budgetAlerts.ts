import crypto from 'crypto';
import { Prisma, type BudgetAlertDelivery, type SubscriptionMirror } from '@prisma/client';
import { sendBudgetAlertEmail } from '../auth/mailer';
import { prisma } from '../lib/prisma';
import { tenantBudgetPolicyLockKey } from './budgets';

const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 10;
const UNRATED_AMOUNT_ISSUE = 'unrated_or_currency_mismatched_usage';

async function updateAmountEvaluationIssue(input: {
  organizationId: string;
  tenantBudgetId: string;
  periodStart: Date;
  periodEnd: Date;
  incompatibleUsageCount: number;
}): Promise<void> {
  if (input.incompatibleUsageCount === 0) {
    await prisma.budgetAlertEvaluationIssue.updateMany({
      where: {
        tenantBudgetId: input.tenantBudgetId,
        code: UNRATED_AMOUNT_ISSUE,
        status: 'active',
      },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
    return;
  }

  await prisma.$transaction([
    prisma.budgetAlertEvaluationIssue.updateMany({
      where: {
        tenantBudgetId: input.tenantBudgetId,
        code: UNRATED_AMOUNT_ISSUE,
        status: 'active',
        periodStart: { not: input.periodStart },
      },
      data: { status: 'resolved', resolvedAt: new Date() },
    }),
    prisma.budgetAlertEvaluationIssue.upsert({
      where: {
        tenantBudgetId_periodStart_code: {
          tenantBudgetId: input.tenantBudgetId,
          periodStart: input.periodStart,
          code: UNRATED_AMOUNT_ISSUE,
        },
      },
      create: {
        organizationId: input.organizationId,
        tenantBudgetId: input.tenantBudgetId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        code: UNRATED_AMOUNT_ISSUE,
        details: { incompatibleUsageCount: input.incompatibleUsageCount },
      },
      update: {
        status: 'active',
        periodEnd: input.periodEnd,
        occurrences: { increment: 1 },
        details: { incompatibleUsageCount: input.incompatibleUsageCount },
        lastSeenAt: new Date(),
        resolvedAt: null,
      },
    }),
  ]);
}

export function alertThresholds(value: Prisma.JsonValue | null): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (entry): entry is number => Number.isInteger(entry) && Number(entry) >= 1 && Number(entry) <= 100
  ))].sort((left, right) => left - right);
}

export function periodFor(
  period: string,
  now: Date,
  subscription: Pick<SubscriptionMirror, 'currentPeriodStart' | 'currentPeriodEnd'> | null
): { start: Date; end: Date } | null {
  if (period === 'daily') {
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
    };
  }
  if (period === 'monthly') {
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }
  if (
    period === 'billing_period' &&
    subscription?.currentPeriodStart &&
    subscription.currentPeriodEnd &&
    subscription.currentPeriodStart <= now &&
    subscription.currentPeriodEnd > now
  ) {
    return { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd };
  }
  return null;
}

export function quantityThresholdReached(
  actual: Prisma.Decimal,
  limit: Prisma.Decimal,
  threshold: number
): boolean {
  const nonNegativeActual = actual.isNegative() ? new Prisma.Decimal(0) : actual;
  if (limit.isZero()) return nonNegativeActual.isPositive();
  return nonNegativeActual.mul(100).greaterThanOrEqualTo(limit.mul(threshold));
}

export function amountThresholdReached(
  actual: Prisma.Decimal,
  limit: bigint,
  threshold: number
): boolean {
  const nonNegativeActual = actual.isNegative() ? new Prisma.Decimal(0) : actual;
  return nonNegativeActual.mul(100).greaterThanOrEqualTo(
    new Prisma.Decimal(limit.toString()).mul(threshold)
  );
}

/** Materialize threshold crossings; uniqueness prevents notification spam. */
export async function evaluateTenantBudgetAlerts(pageSize = 500): Promise<number> {
  const now = new Date();
  const take = Math.max(1, Math.min(pageSize, 5_000));
  const activeWhere = {
    status: 'active',
    effectiveAt: { lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  } satisfies Prisma.TenantBudgetWhereInput;
  const subscriptions = new Map<string, Pick<SubscriptionMirror, 'currentPeriodStart' | 'currentPeriodEnd'> | null>();
  const recipients = new Map<string, string[]>();
  let created = 0;
  let cursor: string | undefined;

  // Sweep every active budget with keyset pagination. A fixed `take` against an
  // unchanged ordering would permanently starve tenants after the first page.
  while (true) {
    const budgets = await prisma.tenantBudget.findMany({
      where: activeWhere,
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (budgets.length === 0) break;

    for (const budget of budgets) {
      const thresholds = alertThresholds(budget.alertThresholds);
      if (thresholds.length === 0) continue;
      if (!subscriptions.has(budget.organizationId)) {
        subscriptions.set(
          budget.organizationId,
          await prisma.subscriptionMirror.findFirst({
            where: {
              organizationId: budget.organizationId,
              billingProvider: 'stripe',
              activeKey: 'current',
            },
            select: { currentPeriodStart: true, currentPeriodEnd: true },
          })
        );
      }
      if (!recipients.has(budget.organizationId)) {
        const memberships = await prisma.organizationMembership.findMany({
          where: {
            organizationId: budget.organizationId,
            role: { in: ['owner', 'admin'] },
            user: { status: 'active' },
          },
          select: { userId: true },
        });
        recipients.set(budget.organizationId, memberships.map(item => item.userId));
      }
      const recipientUserIds = recipients.get(budget.organizationId) ?? [];
      if (recipientUserIds.length === 0) continue;

      const period = periodFor(budget.period, now, subscriptions.get(budget.organizationId) ?? null);
      if (!period) continue;
      const usageWhere: Prisma.UsageEventWhereInput = {
        organizationId: budget.organizationId,
        metric: budget.metric,
        occurredAt: { gte: period.start, lt: period.end },
        ...(budget.clinicId ? { clinicId: budget.clinicId } : {}),
      };
      const actualQuantity = (await prisma.usageEvent.aggregate({
        where: usageWhere,
        _sum: { quantity: true },
      }))._sum.quantity ?? new Prisma.Decimal(0);
      // Soft values are the configured warning point; hard values are the
      // dispatch ceiling. Fall back to hard only when no warning was supplied.
      const quantityLimit = budget.softLimitQuantity ?? budget.hardLimitQuantity;

      const rows: Prisma.BudgetAlertDeliveryCreateManyInput[] = [];
      if (quantityLimit) {
        const threshold = thresholds.filter(
          value => quantityThresholdReached(actualQuantity, quantityLimit, value)
        ).at(-1);
        if (threshold !== undefined) {
          for (const recipientUserId of recipientUserIds) {
            rows.push({
              organizationId: budget.organizationId,
              clinicId: budget.clinicId,
              tenantBudgetId: budget.id,
              recipientUserId,
              metric: budget.metric,
              dimension: 'quantity',
              threshold,
              periodStart: period.start,
              periodEnd: period.end,
              actualQuantity,
              limitQuantity: quantityLimit,
            });
          }
        }
      }

      const amountLimit = budget.softLimitAmountMinor ?? budget.hardLimitAmountMinor;
      if (amountLimit !== null && budget.currency) {
        const incompatible = await prisma.usageEvent.count({
          where: {
            ...usageWhere,
            OR: [
              { ratedAmountSubminor: null },
              { currency: null },
              { currency: { not: budget.currency } },
            ],
          },
        });
        await updateAmountEvaluationIssue({
          organizationId: budget.organizationId,
          tenantBudgetId: budget.id,
          periodStart: period.start,
          periodEnd: period.end,
          incompatibleUsageCount: incompatible,
        });
        if (incompatible === 0) {
          const actualAmountExact = (await prisma.usageEvent.aggregate({
            where: { ...usageWhere, currency: budget.currency },
            _sum: { ratedAmountSubminor: true },
          }))._sum.ratedAmountSubminor ?? new Prisma.Decimal(0);
          const threshold = thresholds.filter(
            value => amountThresholdReached(actualAmountExact, amountLimit, value)
          ).at(-1);
          if (threshold !== undefined) {
            const actualAmount = BigInt(actualAmountExact.toFixed(0));
            for (const recipientUserId of recipientUserIds) {
              rows.push({
                organizationId: budget.organizationId,
                clinicId: budget.clinicId,
                tenantBudgetId: budget.id,
                recipientUserId,
                metric: budget.metric,
                dimension: 'amount',
                threshold,
                periodStart: period.start,
                periodEnd: period.end,
                actualAmountMinor: actualAmount,
                limitAmountMinor: amountLimit,
                currency: budget.currency,
              });
            }
          }
        }
      }

      if (rows.length > 0) {
        const inserted = await prisma.$transaction(async (tx) => {
          const lockKey = tenantBudgetPolicyLockKey({
            organizationId: budget.organizationId,
            clinicId: budget.clinicId,
            metric: budget.metric,
            period: budget.period,
          });
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
          const stillActive = await tx.tenantBudget.findFirst({
            where: {
              id: budget.id,
              status: 'active',
              effectiveAt: { lte: now },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { id: true },
          });
          if (!stillActive) return 0;
          return (await tx.budgetAlertDelivery.createMany({
            data: rows,
            skipDuplicates: true,
          })).count;
        });
        created += inserted;
      }
    }

    cursor = budgets[budgets.length - 1]!.id;
    if (budgets.length < take) break;
  }
  return created;
}

function retryAt(attempt: number): Date {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempt, 10)));
  return new Date(Date.now() + delayMs);
}

type ClaimedDelivery = {
  alert: BudgetAlertDelivery;
  leaseToken: string;
};

async function claimDelivery(candidate: BudgetAlertDelivery): Promise<ClaimedDelivery | null> {
  const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
  const leaseToken = crypto.randomUUID();
  const claimed = await prisma.budgetAlertDelivery.updateMany({
    where: {
      id: candidate.id,
      attempts: candidate.attempts,
      OR: [
        { status: 'pending' },
        { status: 'failed', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
        { status: 'processing', lockedAt: { lte: staleBefore } },
      ],
    },
    data: {
      status: 'processing',
      attempts: { increment: 1 },
      lockedAt: new Date(),
      leaseToken,
      nextAttemptAt: null,
      lastError: null,
    },
  });
  if (claimed.count !== 1) return null;
  const alert = await prisma.budgetAlertDelivery.findFirst({
    where: { id: candidate.id, status: 'processing', leaseToken },
  });
  return alert ? { alert, leaseToken } : null;
}

async function deliverAlert(alert: BudgetAlertDelivery): Promise<boolean> {
  const membership = await prisma.organizationMembership.findFirst({
    where: {
      organizationId: alert.organizationId,
      userId: alert.recipientUserId,
      role: { in: ['owner', 'admin'] },
      user: { status: 'active' },
    },
    select: {
      organization: { select: { name: true } },
      user: { select: { email: true } },
    },
  });
  // Membership changes can legitimately happen after threshold materialization.
  // Do not email a former administrator and do not retry the row forever.
  if (!membership) return false;
  const clinic = alert.clinicId
    ? await prisma.clinic.findFirst({
        where: { id: alert.clinicId, organizationId: alert.organizationId },
        select: { name: true },
      })
    : null;

  const actual = alert.dimension === 'amount'
    ? (alert.actualAmountMinor ?? 0n).toString()
    : alert.actualQuantity?.toFixed() ?? '0';
  const configuredLimit = alert.dimension === 'amount'
    ? (alert.limitAmountMinor ?? 0n).toString()
    : alert.limitQuantity?.toFixed() ?? '0';
  await sendBudgetAlertEmail({
    email: membership.user.email,
    organizationName: membership.organization.name,
    clinicName: clinic?.name ?? null,
    metric: alert.metric,
    threshold: alert.threshold,
    dimension: alert.dimension,
    actual,
    limit: configuredLimit,
    currency: alert.currency,
    periodStart: alert.periodStart,
    periodEnd: alert.periodEnd,
  });
  return true;
}

export async function deliverTenantBudgetAlerts(limit = 100): Promise<{
  delivered: number;
  failed: number;
}> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  await prisma.budgetAlertDelivery.updateMany({
    where: {
      status: 'processing',
      lockedAt: { lte: staleBefore },
      attempts: { gte: MAX_DELIVERY_ATTEMPTS },
    },
    data: { status: 'dead_letter', lockedAt: null, leaseToken: null, nextAttemptAt: null },
  });
  const candidates = await prisma.budgetAlertDelivery.findMany({
    where: {
      attempts: { lt: MAX_DELIVERY_ATTEMPTS },
      OR: [
        { status: 'pending' },
        { status: 'failed', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { status: 'processing', lockedAt: { lte: staleBefore } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.max(1, Math.min(limit, 1_000)),
  });
  let delivered = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claimed = await claimDelivery(candidate);
    if (!claimed) continue;
    const { alert, leaseToken } = claimed;
    try {
      const sent = await deliverAlert(alert);
      const finalized = await prisma.budgetAlertDelivery.updateMany({
        where: { id: alert.id, status: 'processing', leaseToken },
        data: {
          status: sent ? 'delivered' : 'suppressed',
          deliveredAt: sent ? new Date() : null,
          lockedAt: null,
          leaseToken: null,
          lastError: null,
        },
      });
      if (sent && finalized.count === 1) delivered += 1;
    } catch (error) {
      const exhausted = alert.attempts >= MAX_DELIVERY_ATTEMPTS;
      const finalized = await prisma.budgetAlertDelivery.updateMany({
        where: { id: alert.id, status: 'processing', leaseToken },
        data: {
          status: exhausted ? 'dead_letter' : 'failed',
          lockedAt: null,
          leaseToken: null,
          nextAttemptAt: exhausted ? null : retryAt(alert.attempts),
          lastError: error instanceof Error ? error.message.slice(0, 1_000) : 'Unknown delivery error',
        },
      });
      if (finalized.count === 1) failed += 1;
    }
  }
  return { delivered, failed };
}

export async function processTenantBudgetAlerts(): Promise<{
  created: number;
  delivered: number;
  failed: number;
}> {
  const created = await evaluateTenantBudgetAlerts();
  const delivery = await deliverTenantBudgetAlerts();
  return { created, ...delivery };
}
