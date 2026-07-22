import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireStripePlan, UnknownBillingPlanError } from './config';
import { isUsageMetric } from './metrics';
import { StripeApiError, stripeRequest } from './stripeClient';

interface StripeMeterEvent {
  object: 'billing.meter_event';
  identifier: string;
  event_name: string;
  timestamp: number;
}

export class UsageExportError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'UsageExportError';
  }
}

const MAX_EXPORT_ATTEMPTS = 20;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function stripeIdempotencyKey(usageEventId: string): string {
  const digest = crypto.createHash('sha256').update(usageEventId).digest('hex');
  return `meter:${digest}`;
}

async function getOrCreateExport(organizationId: string, usageEventId: string) {
  const idempotencyKey = `usage:${usageEventId}`;
  try {
    return await prisma.usageExport.create({
      data: {
        organizationId,
        usageEventId,
        billingProvider: 'stripe',
        idempotencyKey,
        status: 'pending',
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return prisma.usageExport.findUniqueOrThrow({
      where: {
        billingProvider_idempotencyKey: {
          billingProvider: 'stripe',
          idempotencyKey,
        },
      },
    });
  }
}

export async function exportUsageEventToStripe(usageEventId: string) {
  const usage = await prisma.usageEvent.findUnique({
    where: { id: usageEventId },
    include: {
      priceVersion: { select: { planKey: true } },
      communicationAttempt: { select: { usageFinalizedAt: true } },
      organization: {
        select: {
          planTier: true,
          billingAccount: {
            select: {
              billingProvider: true,
              externalCustomerId: true,
              subscriptions: {
                where: { billingProvider: 'stripe', activeKey: 'current' },
                take: 1,
                select: { planKey: true, status: true },
              },
            },
          },
        },
      },
    },
  });
  if (!usage) throw new UsageExportError('Usage event not found', false);

  const exportRecord = await getOrCreateExport(usage.organizationId, usage.id);
  if (exportRecord.status === 'exported') return exportRecord;

  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const claimed = await prisma.usageExport.updateMany({
    where: {
      id: exportRecord.id,
      OR: [
        { status: { in: ['pending', 'failed'] } },
        { status: 'processing', lastAttemptAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: 'processing',
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      lastError: null,
    },
  });
  if (claimed.count !== 1) {
    return prisma.usageExport.findUniqueOrThrow({ where: { id: exportRecord.id } });
  }

  try {
    if (usage.communicationAttemptId && !usage.communicationAttempt?.usageFinalizedAt) {
      throw new UsageExportError('Provider usage is not finalized yet', true);
    }
    if (!usage.quantity.isInteger() || usage.quantity.isZero()) {
      throw new UsageExportError('Stripe meter quantities must be non-zero integers', false);
    }
    const quantity = usage.quantity.toFixed(0);
    const integerQuantity = BigInt(quantity);
    if (
      integerQuantity > 9_007_199_254_740_991n ||
      integerQuantity < -9_007_199_254_740_991n
    ) {
      throw new UsageExportError('Usage quantity exceeds Stripe integer limits', false);
    }

    const account = usage.organization.billingAccount;
    if (!account || account.billingProvider !== 'stripe') {
      throw new UsageExportError('Stripe billing account is not ready', true);
    }
    const subscription = account.subscriptions[0];
    if (!subscription || !['active', 'trialing', 'past_due'].includes(subscription.status)) {
      throw new UsageExportError('Stripe subscription is not ready for metering', true);
    }

    const planKey = usage.priceVersion?.planKey ?? subscription.planKey ?? usage.organization.planTier;
    const plan = requireStripePlan(planKey);
    if (!isUsageMetric(usage.metric)) {
      throw new UsageExportError('Usage metric has no production emitter', false);
    }
    const eventName = plan.meterEventNames[usage.metric];
    if (!eventName) {
      throw new UsageExportError('Usage metric is not configured for Stripe metering', false);
    }

    const timestamp = Math.floor(usage.occurredAt.getTime() / 1000);
    const oldestAllowed = Math.floor(Date.now() / 1000) - 35 * 86_400;
    const newestAllowed = Math.floor(Date.now() / 1000) + 5 * 60;
    if (timestamp < oldestAllowed || timestamp > newestAllowed) {
      throw new UsageExportError('Usage event timestamp is outside the Stripe meter window', false);
    }

    const meterEvent = await stripeRequest<StripeMeterEvent>('POST', '/v1/billing/meter_events', {
      form: [
        ['event_name', eventName],
        ['payload[stripe_customer_id]', account.externalCustomerId],
        ['payload[value]', quantity],
        ['identifier', usage.id],
        ['timestamp', timestamp],
      ],
      idempotencyKey: stripeIdempotencyKey(usage.id),
    });

    return await prisma.usageExport.update({
      where: { id: exportRecord.id },
      data: {
        status: 'exported',
        externalEventId: meterEvent.identifier,
        exportedAt: new Date(),
        nextAttemptAt: null,
        payload: {
          eventName,
          metric: usage.metric,
          quantity,
          occurredAt: usage.occurredAt.toISOString(),
        },
        response: {
          object: meterEvent.object,
          identifier: meterEvent.identifier,
          timestamp: meterEvent.timestamp,
        },
        lastError: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown usage export error';
    const retryable = error instanceof UsageExportError
      ? error.retryable
      : error instanceof StripeApiError
        ? error.retryable
        : error instanceof UnknownBillingPlanError
          ? false
        : true;
    const attemptNumber = exportRecord.attempts + 1;
    const exhausted = retryable && attemptNumber >= MAX_EXPORT_ATTEMPTS;
    const backoffSeconds = Math.min(3_600, 2 ** Math.min(attemptNumber, 11));
    await prisma.usageExport.update({
      where: { id: exportRecord.id },
      data: {
        status: retryable && !exhausted ? 'failed' : 'quarantined',
        nextAttemptAt: retryable && !exhausted
          ? new Date(Date.now() + backoffSeconds * 1000)
          : null,
        lastError: message.slice(0, 1000),
      },
    });
    throw error;
  }
}

/**
 * Worker entry point. Scheduling is intentionally left to the separate worker
 * deployment; this function can safely be called repeatedly.
 */
export async function exportPendingStripeUsage(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Usage export batch limit must be between 1 and 500');
  }

  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const now = new Date();
  // Rank within each tenant first so one broken tenant cannot monopolize the
  // global export queue. Include stale processing leases so worker crashes are
  // recoverable.
  const [existing, fresh] = await Promise.all([
    prisma.$queryRaw<Array<{ usageEventId: string }>>(Prisma.sql`
      SELECT ranked."usageEventId"
      FROM (
        SELECT ux."usageEventId", ux."organizationId",
          ROW_NUMBER() OVER (
            PARTITION BY ux."organizationId"
            ORDER BY COALESCE(ux."nextAttemptAt", ux."createdAt"), ux."createdAt", ux."id"
          ) AS tenant_rank
        FROM "UsageExport" ux
        WHERE ux."billingProvider" = 'stripe'
          AND (
            ux."status" = 'pending'
            OR (ux."status" = 'failed' AND (ux."nextAttemptAt" IS NULL OR ux."nextAttemptAt" <= ${now}))
            OR (ux."status" = 'processing' AND ux."lastAttemptAt" < ${staleBefore})
          )
      ) ranked
      ORDER BY ranked.tenant_rank, ranked."organizationId", ranked."usageEventId"
      LIMIT ${limit}
    `),
    prisma.$queryRaw<Array<{ usageEventId: string }>>(Prisma.sql`
      SELECT ranked."usageEventId"
      FROM (
        SELECT ue."id" AS "usageEventId", ue."organizationId",
          ROW_NUMBER() OVER (
            PARTITION BY ue."organizationId"
            ORDER BY ue."occurredAt", ue."id"
          ) AS tenant_rank
        FROM "UsageEvent" ue
        LEFT JOIN "CommunicationAttempt" ca
          ON ca."id" = ue."communicationAttemptId"
         AND ca."organizationId" = ue."organizationId"
        WHERE NOT EXISTS (
          SELECT 1 FROM "UsageExport" ux
          WHERE ux."usageEventId" = ue."id"
            AND ux."billingProvider" = 'stripe'
        )
          AND (ue."communicationAttemptId" IS NULL OR ca."usageFinalizedAt" IS NOT NULL)
      ) ranked
      ORDER BY ranked.tenant_rank, ranked."organizationId", ranked."usageEventId"
      LIMIT ${limit}
    `),
  ]);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; ids.length < limit && (index < existing.length || index < fresh.length); index += 1) {
    for (const candidate of [existing[index], fresh[index]]) {
      if (candidate && !seen.has(candidate.usageEventId) && ids.length < limit) {
        seen.add(candidate.usageEventId);
        ids.push(candidate.usageEventId);
      }
    }
  }

  const results: Array<{
    usageEventId: string;
    status: 'exported' | 'failed' | 'quarantined';
    error?: string;
  }> = [];
  for (const id of ids) {
    try {
      await exportUsageEventToStripe(id);
      results.push({ usageEventId: id, status: 'exported' });
    } catch (error) {
      const retryable = error instanceof UsageExportError
        ? error.retryable
        : error instanceof StripeApiError
          ? error.retryable
          : error instanceof UnknownBillingPlanError
            ? false
          : true;
      results.push({
        usageEventId: id,
        status: retryable ? 'failed' : 'quarantined',
        error: error instanceof Error ? error.message : 'Unknown export error',
      });
    }
  }
  return results;
}
