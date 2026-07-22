import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { isUsageMetric } from './metrics';
export { USAGE_METRICS } from './metrics';

export interface RecordUsageInput {
  organizationId: string;
  clinicId?: string | null;
  providerResourceId?: string | null;
  communicationAttemptId?: string | null;
  correctionOfId?: string | null;
  metric: string;
  quantity: Prisma.Decimal.Value;
  unit: string;
  source: string;
  externalEventId?: string | null;
  idempotencyKey: string;
  occurredAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function reservationSnapshot(value: Prisma.JsonValue | null | undefined): {
  planKey: string | null;
  currency: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { planKey: null, currency: null };
  }
  const reservation = (value as Record<string, unknown>).commercialReservation;
  if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)) {
    return { planKey: null, currency: null };
  }
  const record = reservation as Record<string, unknown>;
  return {
    planKey: typeof record.planKey === 'string' ? record.planKey : null,
    currency: typeof record.currency === 'string' ? record.currency : null,
  };
}

/**
 * The local append-only ledger is the billing source of truth. Exporting an
 * event to Stripe (or another billing provider) is a separate, retryable step.
 */
export async function recordUsageEvent(input: RecordUsageInput) {
  if (!isUsageMetric(input.metric)) {
    throw new Error('Usage metric is not supported by the production ledger');
  }
  const occurredAt = input.occurredAt ?? new Date();
  const quantity = new Prisma.Decimal(input.quantity);
  if (!quantity.isFinite() || quantity.isZero()) {
    throw new Error('Usage quantity must be a non-zero finite number');
  }
  if (quantity.isNegative() && !input.correctionOfId) {
    throw new Error('Negative usage is allowed only for an append-only correction');
  }

  return prisma.$transaction(async tx => {
    // Budget reservations use this same lock. Keeping the reservation-to-actual
    // transition behind it prevents an interleaving where a budget reader sees
    // neither the old reservation nor the newly inserted ledger event.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commercial-spend:${input.organizationId}:${input.metric}`}, 0))`;

    const existing = await tx.usageEvent.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (
        existing.metric !== input.metric ||
        existing.unit !== input.unit ||
        !existing.quantity.equals(quantity) ||
        existing.communicationAttemptId !== (input.communicationAttemptId ?? null) ||
        existing.correctionOfId !== (input.correctionOfId ?? null)
      ) {
        throw new Error('Usage idempotency key was reused for a different event');
      }
      return existing;
    }

    const [organization, correctionOf, attempt] = await Promise.all([
      tx.organization.findUnique({
      where: { id: input.organizationId },
      select: {
        planTier: true,
        billingAccount: { select: { currency: true } },
      },
      }),
      input.correctionOfId
        ? tx.usageEvent.findFirst({
            where: { id: input.correctionOfId, organizationId: input.organizationId },
            include: { priceVersion: true },
          })
        : null,
      input.communicationAttemptId
        ? tx.communicationAttempt.findFirst({
            where: {
              id: input.communicationAttemptId,
              organizationId: input.organizationId,
            },
            select: { request: true },
          })
        : null,
    ]);
    if (!organization) throw new Error('Organization not found while recording usage');
    if (
      input.correctionOfId &&
      (!correctionOf || correctionOf.metric !== input.metric || correctionOf.unit !== input.unit)
    ) {
      throw new Error('Usage correction target is invalid');
    }

    if (input.communicationAttemptId && !attempt) {
      throw new Error('Usage communication attribution is invalid');
    }
    const snapshot = reservationSnapshot(attempt?.request);
    const planKey = correctionOf?.priceVersion?.planKey ?? snapshot.planKey ?? organization.planTier;
    const currency = correctionOf?.currency ?? snapshot.currency ?? organization.billingAccount?.currency;
    const priceVersion = correctionOf
      ? correctionOf.priceVersion
      : await tx.priceVersion.findFirst({
      where: {
        planKey,
        metric: input.metric,
        status: 'active',
        effectiveFrom: { lte: occurredAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: occurredAt } }],
        ...(currency ? { currency } : {}),
      },
      orderBy: { effectiveFrom: 'desc' },
        });

    let ratedAmountMinor: bigint | undefined;
    let ratedAmountSubminor: Prisma.Decimal | undefined;
    if (priceVersion) {
      const exact = quantity
        .mul(priceVersion.unitAmountMinor.toString())
        .div(priceVersion.unitQuantity);
      // Preserve fractional minor units so period totals follow Stripe's sum
      // aggregation rather than rounding every provider event independently.
      ratedAmountSubminor = exact;
      ratedAmountMinor = BigInt(exact.toFixed(0));
    }

    return tx.usageEvent.create({
      data: {
        organizationId: input.organizationId,
        clinicId: input.clinicId ?? null,
        providerResourceId: input.providerResourceId ?? null,
        communicationAttemptId: input.communicationAttemptId ?? null,
        correctionOfId: input.correctionOfId ?? null,
        priceVersionId: priceVersion?.id ?? null,
        metric: input.metric,
        quantity,
        unit: input.unit,
        source: input.source,
        externalEventId: input.externalEventId ?? null,
        idempotencyKey: input.idempotencyKey,
        occurredAt,
        ratedAmountMinor,
        ratedAmountSubminor,
        currency: priceVersion?.currency ?? currency ?? null,
        status: priceVersion ? 'rated' : 'unrated',
        metadata: input.metadata,
      },
    });
  });
}

export interface RecordProviderCostInput {
  organizationId: string;
  clinicId?: string | null;
  providerResourceId?: string | null;
  communicationAttemptId?: string | null;
  usageEventId?: string | null;
  reconciliationRunId?: string | null;
  correctionOfId?: string | null;
  provider: string;
  costType: string;
  quantity?: Prisma.Decimal.Value;
  unit?: string;
  /** Amount in millionths of the major currency unit (for example USD). */
  amountMicros: bigint;
  currency: string;
  externalEventId?: string | null;
  idempotencyKey: string;
  occurredAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

export async function recordProviderCost(input: RecordProviderCostInput) {
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error('Provider cost currency must be an uppercase three-letter code');
  }
  if (input.amountMicros < 0n && !input.correctionOfId) {
    throw new Error('Negative provider cost is allowed only for an append-only correction');
  }
  const quantity = input.quantity === undefined ? null : new Prisma.Decimal(input.quantity);
  if (quantity && (!quantity.isFinite() || (quantity.isNegative() && !input.correctionOfId))) {
    throw new Error('Provider cost quantity is invalid');
  }
  if (input.correctionOfId) {
    const original = await prisma.providerCostEntry.findFirst({
      where: {
        id: input.correctionOfId,
        organizationId: input.organizationId,
        provider: input.provider,
        costType: input.costType,
        currency: input.currency,
      },
      select: { id: true },
    });
    if (!original) throw new Error('Provider-cost correction target is invalid');
  }
  try {
    return await prisma.providerCostEntry.create({
      data: {
        organizationId: input.organizationId,
        clinicId: input.clinicId ?? null,
        providerResourceId: input.providerResourceId ?? null,
        communicationAttemptId: input.communicationAttemptId ?? null,
        usageEventId: input.usageEventId ?? null,
        reconciliationRunId: input.reconciliationRunId ?? null,
        correctionOfId: input.correctionOfId ?? null,
        provider: input.provider,
        costType: input.costType,
        quantity,
        unit: input.unit ?? null,
        amountMicros: input.amountMicros,
        currency: input.currency,
        externalEventId: input.externalEventId ?? null,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt ?? new Date(),
        metadata: input.metadata,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await prisma.providerCostEntry.findUniqueOrThrow({
      where: {
        provider_idempotencyKey: {
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (
      existing.organizationId !== input.organizationId ||
      existing.communicationAttemptId !== (input.communicationAttemptId ?? null) ||
      existing.costType !== input.costType ||
      existing.currency !== input.currency ||
      existing.amountMicros !== input.amountMicros ||
      existing.correctionOfId !== (input.correctionOfId ?? null)
    ) {
      throw new Error('Provider-cost idempotency key was reused for a different event');
    }
    return existing;
  }
}
