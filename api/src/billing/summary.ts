import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

function defaultBillingPeriod(now = new Date()) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function decimalString(value: Prisma.Decimal | null | undefined): string {
  return value?.toFixed() ?? '0';
}

export async function getBillingSummary(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      planTier: true,
      status: true,
      billingAccount: {
        select: {
          billingProvider: true,
          status: true,
          currency: true,
          subscriptions: {
            where: { activeKey: 'current' },
            take: 1,
            select: {
              id: true,
              planKey: true,
              status: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              trialEnd: true,
              cancelAtPeriodEnd: true,
              canceledAt: true,
              graceUntil: true,
            },
          },
        },
      },
      entitlements: {
        orderBy: { key: 'asc' },
        select: {
          key: true,
          enabled: true,
          limit: true,
          unit: true,
          value: true,
          effectiveAt: true,
          expiresAt: true,
        },
      },
      tenantBudgets: {
        where: { status: 'active' },
        orderBy: [{ metric: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          clinicId: true,
          metric: true,
          period: true,
          currency: true,
          softLimitQuantity: true,
          hardLimitQuantity: true,
          softLimitAmountMinor: true,
          hardLimitAmountMinor: true,
          enforcementMode: true,
          alertThresholds: true,
          effectiveAt: true,
          expiresAt: true,
        },
      },
    },
  });
  if (!organization) throw new Error('Organization not found');

  const subscription = organization.billingAccount?.subscriptions[0] ?? null;
  const fallback = defaultBillingPeriod();
  const periodStart = subscription?.currentPeriodStart ?? fallback.start;
  const periodEnd = subscription?.currentPeriodEnd ?? fallback.end;

  const [groups, unratedGroups, clinics] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ['metric', 'clinicId', 'currency'],
      where: {
        organizationId,
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      _sum: { quantity: true, ratedAmountSubminor: true },
      _count: { _all: true },
      orderBy: [{ metric: 'asc' }, { clinicId: 'asc' }],
    }),
    prisma.usageEvent.groupBy({
      by: ['metric', 'clinicId', 'currency'],
      where: {
        organizationId,
        occurredAt: { gte: periodStart, lt: periodEnd },
        ratedAmountSubminor: null,
      },
      _count: { _all: true },
    }),
    prisma.clinic.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    }),
  ]);

  const clinicNames = new Map(clinics.map((clinic) => [clinic.id, clinic.name]));
  const unratedCounts = new Map(
    unratedGroups.map((group) => [
      `${group.metric}:${group.clinicId ?? ''}:${group.currency ?? ''}`,
      group._count._all,
    ])
  );
  const estimateByCurrency = new Map<string, Prisma.Decimal>();
  for (const group of groups) {
    if (group.currency && group._sum.ratedAmountSubminor !== null) {
      estimateByCurrency.set(
        group.currency,
        (estimateByCurrency.get(group.currency) ?? new Prisma.Decimal(0))
          .plus(group._sum.ratedAmountSubminor)
      );
    }
  }

  return {
    organization: {
      id: organization.id,
      status: organization.status,
      planKey: organization.planTier,
    },
    billingAccount: organization.billingAccount
      ? {
          provider: organization.billingAccount.billingProvider,
          status: organization.billingAccount.status,
          currency: organization.billingAccount.currency,
        }
      : null,
    subscription,
    period: { start: periodStart, end: periodEnd },
    usage: groups.map((group) => ({
      metric: group.metric,
      clinicId: group.clinicId,
      clinicName: group.clinicId ? clinicNames.get(group.clinicId) ?? null : null,
      currency: group.currency,
      quantity: decimalString(group._sum.quantity),
      ratedAmountMinor: group._sum.ratedAmountSubminor?.toFixed(0) ?? null,
      eventCount: group._count._all,
      unratedEventCount: unratedCounts.get(
        `${group.metric}:${group.clinicId ?? ''}:${group.currency ?? ''}`
      ) ?? 0,
    })),
    estimate: {
      kind: 'usage_only_unfinalized',
      amounts: [...estimateByCurrency.entries()].map(([currency, amountMinor]) => ({
        currency,
        amountMinor: amountMinor.toFixed(0),
      })),
      excludesTaxesDiscountsAndBaseFees: true,
    },
    entitlements: organization.entitlements.map((entitlement) => ({
      ...entitlement,
      limit: entitlement.limit?.toFixed() ?? null,
    })),
    budgets: organization.tenantBudgets.map((budget) => ({
      ...budget,
      softLimitQuantity: budget.softLimitQuantity?.toFixed() ?? null,
      hardLimitQuantity: budget.hardLimitQuantity?.toFixed() ?? null,
      softLimitAmountMinor: budget.softLimitAmountMinor?.toString() ?? null,
      hardLimitAmountMinor: budget.hardLimitAmountMinor?.toString() ?? null,
    })),
  };
}
