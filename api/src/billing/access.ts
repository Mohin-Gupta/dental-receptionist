import { Prisma, type CommunicationAttempt } from '@prisma/client';
import { prisma } from '../lib/prisma';

export const COMMERCIAL_FEATURES = {
  APPOINTMENTS: 'appointments.write',
  SMS: 'communications.sms',
  VOICE: 'communications.voice',
} as const;

export type CommercialFeature = (typeof COMMERCIAL_FEATURES)[keyof typeof COMMERCIAL_FEATURES];

export class CommercialAccessError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'organization_inactive'
      | 'subscription_inactive'
      | 'feature_disabled'
      | 'budget_exceeded'
      | 'billing_configuration_error',
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'CommercialAccessError';
  }
}

type Transaction = Prisma.TransactionClient;

interface AccessSnapshot {
  organization: {
    id: string;
    status: string;
    planTier: string;
    billingAccount: { currency: string } | null;
  };
  subscription: {
    id: string;
    planKey: string;
    status: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    trialEnd: Date | null;
    graceUntil: Date | null;
  } | null;
}

function developmentBypassEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_UNENTITLED_DEV_ACCESS === 'true'
  );
}

function entitlementIsCurrent(
  entitlement: { enabled: boolean; effectiveAt: Date; expiresAt: Date | null },
  now: Date
): boolean {
  return (
    entitlement.enabled &&
    entitlement.effectiveAt <= now &&
    (!entitlement.expiresAt || entitlement.expiresAt > now)
  );
}

function subscriptionIsCurrent(
  subscription: AccessSnapshot['subscription'],
  now: Date
): boolean {
  if (!subscription || !['active', 'trialing'].includes(subscription.status)) return false;
  if (subscription.status === 'trialing' && subscription.trialEnd) {
    return subscription.trialEnd > now;
  }
  return Boolean(subscription.currentPeriodEnd && subscription.currentPeriodEnd > now);
}

async function assertFeatureAccessTx(
  tx: Transaction,
  input: { organizationId: string; clinicId?: string | null; feature: CommercialFeature },
  now: Date
): Promise<AccessSnapshot> {
  const organization = await tx.organization.findUnique({
    where: { id: input.organizationId },
    select: {
      id: true,
      status: true,
      planTier: true,
      billingAccount: { select: { currency: true } },
    },
  });
  if (!organization || !['active', 'past_due_grace'].includes(organization.status)) {
    throw new CommercialAccessError(
      'This organization is not enabled for operational activity',
      'organization_inactive',
      403
    );
  }

  if (input.clinicId) {
    const clinic = await tx.clinic.findFirst({
      where: { id: input.clinicId, organizationId: input.organizationId, status: 'active' },
      select: { id: true },
    });
    if (!clinic) {
      throw new CommercialAccessError(
        'The clinic does not belong to this organization',
        'organization_inactive',
        403
      );
    }
  }

  const entitlement = await tx.entitlement.findUnique({
    where: {
      organizationId_key: {
        organizationId: input.organizationId,
        key: input.feature,
      },
    },
  });

  const devBypass = developmentBypassEnabled();
  const currentEntitlement = entitlement && entitlementIsCurrent(entitlement, now)
    ? entitlement
    : null;
  if (!currentEntitlement && !devBypass) {
    throw new CommercialAccessError(
      'The current plan does not include this feature',
      'feature_disabled',
      402
    );
  }

  // A Stripe entitlement must be evaluated against the exact subscription that
  // materialized it. Selecting merely the most recently updated subscription
  // lets an unrelated/old subscription shadow or accidentally authorize it.
  const linkedStripeSubscriptionId = currentEntitlement?.source === 'stripe-plan'
    ? currentEntitlement.subscriptionMirrorId
    : null;
  const subscription = await tx.subscriptionMirror.findFirst({
    where: {
      organizationId: input.organizationId,
      billingProvider: 'stripe',
      ...(linkedStripeSubscriptionId
        ? { id: linkedStripeSubscriptionId }
        : organization.status === 'past_due_grace'
          ? { status: 'past_due' }
          : { status: { in: ['active', 'trialing'] } }),
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      planKey: true,
      status: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      trialEnd: true,
      graceUntil: true,
    },
  });
  const stripeGrantMatches = Boolean(
    currentEntitlement?.source === 'stripe-plan' &&
    linkedStripeSubscriptionId &&
    linkedStripeSubscriptionId === subscription?.id &&
    subscription.planKey === organization.planTier
  );

  if (organization.status === 'past_due_grace') {
    if (
      !subscription ||
      subscription.status !== 'past_due' ||
      !subscription.graceUntil ||
      subscription.graceUntil <= now ||
      (currentEntitlement?.source === 'stripe-plan' && !stripeGrantMatches)
    ) {
      throw new CommercialAccessError(
        'The billing grace period has expired',
        'subscription_inactive',
        402
      );
    }
  } else {
    const manualGrant = currentEntitlement && currentEntitlement.source !== 'stripe-plan';
    if (
      !manualGrant &&
      !(stripeGrantMatches && subscriptionIsCurrent(subscription, now)) &&
      !devBypass
    ) {
      throw new CommercialAccessError(
        'An active subscription is required for this feature',
        'subscription_inactive',
        402
      );
    }
  }

  return { organization, subscription };
}

export async function assertCommercialFeatureAccess(input: {
  organizationId: string;
  clinicId?: string | null;
  feature: CommercialFeature;
}): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commercial-access:${input.organizationId}`}, 0))`;
    await assertFeatureAccessTx(tx, input, new Date());
  });
}

/** Recheck access inside a business transaction immediately before its write. */
export async function assertCommercialFeatureAccessTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    clinicId?: string | null;
    feature: CommercialFeature;
  },
  now = new Date()
): Promise<void> {
  await assertFeatureAccessTx(tx, input, now);
}

function jsonObject(value: Prisma.JsonValue | Prisma.InputJsonValue | null | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.InputJsonValue>
    : {};
}

function reservationQuantity(request: Prisma.JsonValue, metric: string): Prisma.Decimal | null {
  const reservation = jsonObject(jsonObject(request).commercialReservation as Prisma.JsonValue);
  if (reservation.metric !== metric || typeof reservation.quantity !== 'string') return null;
  try {
    const quantity = new Prisma.Decimal(reservation.quantity);
    return quantity.isFinite() && quantity.isPositive() ? quantity : null;
  } catch {
    return null;
  }
}

function utcPeriod(period: string, now: Date, subscription: AccessSnapshot['subscription']) {
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
    subscription.currentPeriodEnd
  ) {
    return { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd };
  }
  throw new CommercialAccessError(
    'The tenant budget period cannot be evaluated',
    'billing_configuration_error',
    503
  );
}

function blockingQuantityLimit(budget: {
  enforcementMode: string;
  softLimitQuantity: Prisma.Decimal | null;
  hardLimitQuantity: Prisma.Decimal | null;
}) {
  if (budget.enforcementMode === 'soft_block') {
    return budget.softLimitQuantity ?? budget.hardLimitQuantity;
  }
  if (budget.enforcementMode === 'hard_block') {
    return budget.hardLimitQuantity ?? budget.softLimitQuantity;
  }
  return null;
}

function blockingAmountLimit(budget: {
  enforcementMode: string;
  softLimitAmountMinor: bigint | null;
  hardLimitAmountMinor: bigint | null;
}) {
  if (budget.enforcementMode === 'soft_block') {
    return budget.softLimitAmountMinor ?? budget.hardLimitAmountMinor;
  }
  if (budget.enforcementMode === 'hard_block') {
    return budget.hardLimitAmountMinor ?? budget.softLimitAmountMinor;
  }
  return null;
}

async function loadActivePrice(
  tx: Transaction,
  planTier: string,
  metric: string,
  currency: string,
  now: Date
): Promise<{ unitAmountMinor: bigint; unitQuantity: Prisma.Decimal }> {
  const price = await tx.priceVersion.findFirst({
    where: {
      planKey: planTier,
      metric,
      currency,
      status: 'active',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!price) {
    throw new CommercialAccessError(
      'No active price exists for the enforced budget currency',
      'billing_configuration_error',
      503
    );
  }
  return price;
}

function priceCandidateMinor(
  price: { unitAmountMinor: bigint; unitQuantity: Prisma.Decimal },
  quantity: Prisma.Decimal
): Prisma.Decimal {
  return quantity
    .mul(price.unitAmountMinor.toString())
    .div(price.unitQuantity);
}

async function enforceBudgetsTx(
  tx: Transaction,
  input: {
    organizationId: string;
    clinicId: string;
    metric: string;
    estimatedQuantity: Prisma.Decimal;
    excludeAttemptId?: string;
  },
  access: AccessSnapshot,
  now: Date
) {
  const budgets = await tx.tenantBudget.findMany({
    where: {
      organizationId: input.organizationId,
      metric: input.metric,
      status: 'active',
      effectiveAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      AND: [{ OR: [{ clinicId: null }, { clinicId: input.clinicId }] }],
    },
    orderBy: [{ clinicId: 'desc' }, { createdAt: 'desc' }],
  });

  for (const budget of budgets) {
    if (budget.enforcementMode === 'alert') continue;
    if (!['soft_block', 'hard_block'].includes(budget.enforcementMode)) {
      throw new CommercialAccessError(
        'The tenant budget has an unsupported enforcement mode',
        'billing_configuration_error',
        503
      );
    }
    const quantityLimit = blockingQuantityLimit(budget);
    const amountLimit = blockingAmountLimit(budget);
    if (quantityLimit === null && amountLimit === null) {
      throw new CommercialAccessError(
        'The blocking tenant budget has no enforceable limit',
        'billing_configuration_error',
        503
      );
    }
    const period = utcPeriod(budget.period, now, access.subscription);
    const usageWhere: Prisma.UsageEventWhereInput = {
      organizationId: input.organizationId,
      metric: input.metric,
      occurredAt: { gte: period.start, lt: period.end },
      ...(budget.clinicId ? { clinicId: budget.clinicId } : {}),
    };

    const [actual, attempts] = await Promise.all([
      tx.usageEvent.aggregate({
        where: usageWhere,
        _sum: { quantity: true },
      }),
      tx.communicationAttempt.findMany({
        where: {
          organizationId: input.organizationId,
          createdAt: { gte: period.start, lt: period.end },
          status: { notIn: ['failed', 'canceled', 'cancelled'] },
          ...(budget.clinicId ? { clinicId: budget.clinicId } : {}),
          ...(input.excludeAttemptId ? { id: { not: input.excludeAttemptId } } : {}),
        },
        select: {
          request: true,
          usageEvents: {
            where: { metric: input.metric, occurredAt: { gte: period.start, lt: period.end } },
            select: { id: true },
            take: 1,
          },
        },
      }),
    ]);

    const reservedQuantities = attempts.flatMap((attempt) => {
      if (attempt.usageEvents.length > 0) return [];
      const quantity = reservationQuantity(attempt.request, input.metric);
      return quantity ? [quantity] : [];
    });
    const reserved = reservedQuantities.reduce(
      (sum, quantity) => sum.plus(quantity),
      new Prisma.Decimal(0)
    );
    const actualQuantity = actual._sum.quantity ?? new Prisma.Decimal(0);
    const projectedQuantity = actualQuantity.plus(reserved).plus(input.estimatedQuantity);
    if (quantityLimit && projectedQuantity.greaterThan(quantityLimit)) {
      throw new CommercialAccessError(
        'The tenant usage budget has been reached',
        'budget_exceeded',
        402
      );
    }

    if (amountLimit !== null) {
      if (!budget.currency) {
        throw new CommercialAccessError(
          'The enforced monetary budget has no currency',
          'billing_configuration_error',
          503
        );
      }
      const incompatibleUsage = await tx.usageEvent.count({
        where: {
          ...usageWhere,
          OR: [
            { ratedAmountSubminor: null },
            { currency: null },
            { currency: { not: budget.currency } },
          ],
        },
      });
      if (incompatibleUsage > 0) {
        throw new CommercialAccessError(
          'The enforced monetary budget contains unrated or mismatched usage',
          'billing_configuration_error',
          503
        );
      }
      const actualAmount = await tx.usageEvent.aggregate({
        where: { ...usageWhere, currency: budget.currency },
        _sum: { ratedAmountSubminor: true },
      });
      // Usage events are rated and rounded independently. Price each pending
      // attempt independently as well; pricing their aggregate once can
      // under-reserve when several fractional per-event amounts round upward.
      const activePrice = await loadActivePrice(
        tx,
        access.organization.planTier,
        input.metric,
        budget.currency,
        now
      );
      let pendingAmount = new Prisma.Decimal(0);
      for (const pendingQuantity of [...reservedQuantities, input.estimatedQuantity]) {
        pendingAmount = pendingAmount.plus(priceCandidateMinor(activePrice, pendingQuantity));
      }
      const projectedAmount = (actualAmount._sum.ratedAmountSubminor ?? new Prisma.Decimal(0))
        .plus(pendingAmount);
      // Round the aggregate upward for a conservative dispatch decision. This
      // mirrors sum-meter pricing and cannot under-reserve by rounding each
      // provider event separately.
      if (projectedAmount.ceil().greaterThan(amountLimit.toString())) {
        throw new CommercialAccessError(
          'The tenant monetary usage budget has been reached',
          'budget_exceeded',
          402
        );
      }
    }
  }
}

interface CommunicationCreateData {
  providerResourceId?: string | null;
  patientId?: string | null;
  appointmentId?: string | null;
  callLogId?: string | null;
  provider: string;
  channel: string;
  direction: string;
  externalId?: string | null;
  status: string;
  destination?: string | null;
  origin?: string | null;
  startedAt?: Date | null;
  request?: Prisma.InputJsonObject;
}

export async function reserveCommunicationAttempt(input: {
  organizationId: string;
  clinicId: string;
  idempotencyKey: string;
  feature: CommercialFeature;
  metric: string;
  estimatedQuantity: Prisma.Decimal.Value;
  unit: string;
  attempt: CommunicationCreateData;
}): Promise<CommunicationAttempt> {
  const quantity = new Prisma.Decimal(input.estimatedQuantity);
  if (!quantity.isFinite() || !quantity.isPositive()) {
    throw new Error('A positive finite reservation quantity is required');
  }

  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commercial-spend:${input.organizationId}:${input.metric}`}, 0))`;
    const now = new Date();
    const access = await assertFeatureAccessTx(tx, input, now);
    const existing = await tx.communicationAttempt.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    const priorReservation = existing
      ? reservationQuantity(existing.request, input.metric)
      : null;
    // Never shrink an in-flight reservation. This matters for inbound calls
    // crossing a rolling deploy where the configured duration ceiling may
    // have changed between two tool-call webhooks.
    const effectiveQuantity = priorReservation?.greaterThan(quantity)
      ? priorReservation
      : quantity;

    await enforceBudgetsTx(tx, {
      organizationId: input.organizationId,
      clinicId: input.clinicId,
      metric: input.metric,
      estimatedQuantity: effectiveQuantity,
      excludeAttemptId: existing?.id,
    }, access, now);

    const request: Prisma.InputJsonObject = {
      ...jsonObject(existing?.request ?? input.attempt.request),
      ...jsonObject(input.attempt.request),
      commercialReservation: {
        feature: input.feature,
        metric: input.metric,
        quantity: effectiveQuantity.toFixed(),
        unit: input.unit,
        planKey: access.organization.planTier,
        currency: access.organization.billingAccount?.currency ?? null,
        reservedAt: now.toISOString(),
      },
    };

    if (existing) {
      if (
        existing.provider !== input.attempt.provider ||
        existing.channel !== input.attempt.channel ||
        existing.direction !== input.attempt.direction ||
        existing.clinicId !== input.clinicId
      ) {
        throw new Error('Communication idempotency key collision');
      }
      return tx.communicationAttempt.update({
        where: { id: existing.id },
        data: {
          providerResourceId: input.attempt.providerResourceId,
          request,
        },
      });
    }

    return tx.communicationAttempt.create({
      data: {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        idempotencyKey: input.idempotencyKey,
        ...input.attempt,
        request,
      },
    });
  });
}

export async function reserveExistingCommunicationAttempt(input: {
  attemptId: string;
  organizationId: string;
  clinicId: string;
  feature: CommercialFeature;
  metric: string;
  estimatedQuantity: Prisma.Decimal.Value;
  unit: string;
}): Promise<void> {
  const attempt = await prisma.communicationAttempt.findFirst({
    where: {
      id: input.attemptId,
      organizationId: input.organizationId,
      clinicId: input.clinicId,
    },
  });
  if (!attempt) throw new Error('Communication attempt attribution is invalid');

  await reserveCommunicationAttempt({
    organizationId: input.organizationId,
    clinicId: input.clinicId,
    idempotencyKey: attempt.idempotencyKey,
    feature: input.feature,
    metric: input.metric,
    estimatedQuantity: input.estimatedQuantity,
    unit: input.unit,
    attempt: {
      providerResourceId: attempt.providerResourceId,
      patientId: attempt.patientId,
      appointmentId: attempt.appointmentId,
      callLogId: attempt.callLogId,
      provider: attempt.provider,
      channel: attempt.channel,
      direction: attempt.direction,
      externalId: attempt.externalId,
      status: attempt.status,
      destination: attempt.destination,
      origin: attempt.origin,
      startedAt: attempt.startedAt,
    },
  });
}
