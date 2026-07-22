import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireStripePlan } from './config';
import { RESERVABLE_USAGE_METRIC_VALUES, USAGE_METRIC_VALUES } from './metrics';

const metric = z.enum(USAGE_METRIC_VALUES);
const quantity = z.union([
  z.string().trim().regex(/^\d{1,14}(?:\.\d{1,6})?$/),
  z.number().finite().positive().max(99_999_999_999_999),
]).transform(String).refine(
  (value) => /^\d{1,14}(?:\.\d{1,6})?$/.test(value) && new Prisma.Decimal(value).greaterThan(0),
  'Quantity must be positive with at most 14 integer and 6 decimal digits'
);
const minorAmount = z.union([
  z.string().trim().regex(/^\d{1,18}$/),
  z.number().int().positive().safe(),
]).transform(String).refine((value) => BigInt(value) > 0n, 'Amount must be positive');

export const tenantBudgetInputSchema = z.object({
  clinicId: z.string().trim().min(1).max(100).nullable().optional(),
  metric,
  period: z.enum(['daily', 'monthly', 'billing_period']).default('monthly'),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()).nullable().optional(),
  softLimitQuantity: quantity.nullable().optional(),
  hardLimitQuantity: quantity.nullable().optional(),
  softLimitAmountMinor: minorAmount.nullable().optional(),
  hardLimitAmountMinor: minorAmount.nullable().optional(),
  enforcementMode: z.enum(['alert', 'soft_block', 'hard_block']).default('alert'),
  alertThresholds: z.array(z.number().int().min(1).max(100)).min(1).max(10).default([50, 75, 90, 100]),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().superRefine((value, context) => {
  const hasQuantity = value.softLimitQuantity != null || value.hardLimitQuantity != null;
  const hasAmount = value.softLimitAmountMinor != null || value.hardLimitAmountMinor != null;
  if (!hasQuantity && !hasAmount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one quantity or amount limit is required',
    });
  }
  if (hasAmount && !value.currency) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['currency'],
      message: 'Currency is required for monetary limits',
    });
  }
  const reservable = (RESERVABLE_USAGE_METRIC_VALUES as readonly string[]).includes(value.metric);
  if (!reservable && value.enforcementMode !== 'alert') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enforcementMode'],
      message: 'This metric is measured only after provider consumption and supports alerts, not blocking',
    });
  }
  if (
    !reservable &&
    (value.hardLimitQuantity != null || value.hardLimitAmountMinor != null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hardLimitQuantity'],
      message: 'Hard limits require a metric that can be reserved before provider dispatch',
    });
  }
  if (
    value.softLimitQuantity != null && value.hardLimitQuantity != null &&
    new Prisma.Decimal(value.softLimitQuantity).greaterThan(value.hardLimitQuantity)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hardLimitQuantity'],
      message: 'Hard quantity limit must be at least the soft limit',
    });
  }
  if (
    value.softLimitAmountMinor != null && value.hardLimitAmountMinor != null &&
    BigInt(value.softLimitAmountMinor) > BigInt(value.hardLimitAmountMinor)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hardLimitAmountMinor'],
      message: 'Hard amount limit must be at least the soft limit',
    });
  }
  if (value.expiresAt && new Date(value.expiresAt).getTime() <= Date.now()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Budget expiry must be in the future',
    });
  }
});

export type TenantBudgetInput = z.infer<typeof tenantBudgetInputSchema>;

export class TenantBudgetInputError extends Error {
  readonly statusCode = 400;
}

export function tenantBudgetPolicyLockKey(input: {
  organizationId: string;
  clinicId: string | null;
  metric: string;
  period: string;
}): string {
  return `tenant-budget:${input.organizationId}:${input.clinicId ?? '*'}:${input.metric}:${input.period}`;
}

function sameDecimal(left: Prisma.Decimal | null, right: Prisma.Decimal | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function sameThresholds(value: Prisma.JsonValue | null, expected: number[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

export async function saveTenantBudget(organizationId: string, input: TenantBudgetInput) {
  const clinicId = input.clinicId ?? null;
  const hasAmountLimit = input.softLimitAmountMinor != null || input.hardLimitAmountMinor != null;
  const budgetCurrency = hasAmountLimit ? input.currency ?? null : null;
  const lockKey = tenantBudgetPolicyLockKey({
    organizationId,
    clinicId,
    metric: input.metric,
    period: input.period,
  });
  return prisma.$transaction(async (tx) => {
    // Serialize a limit change with spend reservations for the same tenant and
    // metric, so lowering a budget cannot race one last provider dispatch.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commercial-spend:${organizationId}:${input.metric}`}, 0))`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: {
        planTier: true,
        billingAccount: {
          select: {
            currency: true,
            subscriptions: {
              where: { billingProvider: 'stripe', activeKey: 'current' },
              take: 1,
              select: { currentPeriodStart: true, currentPeriodEnd: true },
            },
          },
        },
      },
    });
    if (!organization) throw new TenantBudgetInputError('Organization not found');
    if (clinicId) {
      const clinic = await tx.clinic.findFirst({
        where: { id: clinicId, organizationId, status: 'active' },
        select: { id: true },
      });
      if (!clinic) {
        throw new TenantBudgetInputError('Clinic does not belong to this organization or is archived');
      }
    }
    if (budgetCurrency) {
      const expectedCurrency = organization.billingAccount?.currency ??
        requireStripePlan(organization.planTier).currency;
      if (budgetCurrency !== expectedCurrency) {
        throw new TenantBudgetInputError(
          `Budget currency must match the organization billing currency (${expectedCurrency})`
        );
      }
    }
    if (input.period === 'billing_period') {
      const subscription = organization.billingAccount?.subscriptions[0];
      const now = Date.now();
      if (
        !subscription?.currentPeriodStart ||
        !subscription.currentPeriodEnd ||
        subscription.currentPeriodStart.getTime() > now ||
        subscription.currentPeriodEnd.getTime() <= now
      ) {
        throw new TenantBudgetInputError(
          'A current subscription period is required for a billing-period budget'
        );
      }
    }

    const effectiveAt = new Date();
    const activeBudgetWhere = {
      organizationId,
      clinicId,
      metric: input.metric,
      period: input.period,
      status: 'active',
    } satisfies Prisma.TenantBudgetWhereInput;

    const alertThresholds = [...new Set(input.alertThresholds)].sort((a, b) => a - b);
    const data = {
      clinicId,
      metric: input.metric,
      period: input.period,
      currency: budgetCurrency,
      softLimitQuantity: input.softLimitQuantity == null
        ? null
        : new Prisma.Decimal(input.softLimitQuantity),
      hardLimitQuantity: input.hardLimitQuantity == null
        ? null
        : new Prisma.Decimal(input.hardLimitQuantity),
      softLimitAmountMinor: input.softLimitAmountMinor == null
        ? null
        : BigInt(input.softLimitAmountMinor),
      hardLimitAmountMinor: input.hardLimitAmountMinor == null
        ? null
        : BigInt(input.hardLimitAmountMinor),
      enforcementMode: input.enforcementMode,
      alertThresholds,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      effectiveAt,
      status: 'active',
    } satisfies Omit<Prisma.TenantBudgetUncheckedCreateInput, 'id' | 'organizationId' | 'createdAt' | 'updatedAt'>;

    const activeBudgets = await tx.tenantBudget.findMany({
      where: activeBudgetWhere,
      orderBy: { createdAt: 'desc' },
    });
    const current = activeBudgets[0];
    const unchanged = current &&
      activeBudgets.length === 1 &&
      current.currency === data.currency &&
      sameDecimal(current.softLimitQuantity, data.softLimitQuantity) &&
      sameDecimal(current.hardLimitQuantity, data.hardLimitQuantity) &&
      current.softLimitAmountMinor === data.softLimitAmountMinor &&
      current.hardLimitAmountMinor === data.hardLimitAmountMinor &&
      current.enforcementMode === data.enforcementMode &&
      sameThresholds(current.alertThresholds, alertThresholds) &&
      sameDate(current.expiresAt, data.expiresAt);
    if (unchanged) return current;

    // Budget policy is financial control data. Preserve every revision instead
    // of overwriting the row that governed earlier provider dispatches.
    await tx.tenantBudget.updateMany({
      where: activeBudgetWhere,
      data: { status: 'superseded', expiresAt: effectiveAt },
    });
    if (activeBudgets.length > 0) {
      await tx.budgetAlertEvaluationIssue.updateMany({
        where: {
          tenantBudgetId: { in: activeBudgets.map(budget => budget.id) },
          status: 'active',
        },
        data: { status: 'resolved', resolvedAt: effectiveAt },
      });
      await tx.budgetAlertDelivery.updateMany({
        where: {
          tenantBudgetId: { in: activeBudgets.map(budget => budget.id) },
          status: { in: ['pending', 'failed'] },
        },
        data: {
          status: 'suppressed',
          nextAttemptAt: null,
          lockedAt: null,
          leaseToken: null,
        },
      });
    }
    return tx.tenantBudget.create({ data: { organizationId, ...data } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function serializeTenantBudget<T extends {
  softLimitQuantity: Prisma.Decimal | null;
  hardLimitQuantity: Prisma.Decimal | null;
  softLimitAmountMinor: bigint | null;
  hardLimitAmountMinor: bigint | null;
}>(budget: T) {
  return {
    ...budget,
    softLimitQuantity: budget.softLimitQuantity?.toFixed() ?? null,
    hardLimitQuantity: budget.hardLimitQuantity?.toFixed() ?? null,
    softLimitAmountMinor: budget.softLimitAmountMinor?.toString() ?? null,
    hardLimitAmountMinor: budget.hardLimitAmountMinor?.toString() ?? null,
  };
}
