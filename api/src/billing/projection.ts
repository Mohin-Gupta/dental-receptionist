import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  getRazorpayRuntimeConfig,
  planKeyForRazorpayPlanId,
  requireRazorpayPlan,
  UnknownBillingPlanError,
} from './config';
import {
  RazorpayApiError,
  razorpayPathId,
  razorpayRequest,
  type RazorpaySubscriptionEntity,
} from './razorpayClient';
import type { RazorpayWebhookEvent } from './razorpayWebhook';
import { BILLING_MANAGED_ENTITLEMENT_SOURCES } from './access';

const PROVIDER = 'razorpay';
const CURRENT_PROVIDER_STATUSES = new Set([
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'paused',
]);
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.completed',
  'subscription.updated',
  'subscription.pending',
  'subscription.halted',
  'subscription.paused',
  'subscription.resumed',
  'subscription.cancelled',
]);
const MAX_CANONICAL_PROJECTION_ATTEMPTS = 5;

interface ProjectionRevision {
  id: string;
  status: string;
  providerStatus: string | null;
  activeKey: string | null;
  lastProviderEventId: string | null;
  lastProviderEventCreatedAt: Date | null;
  updatedAt: Date;
}

class ProjectionRevisionChangedError extends Error {
  constructor() {
    super('Subscription projection changed during canonical provider read');
    this.name = 'ProjectionRevisionChangedError';
  }
}

export class BillingProjectionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly providerStatusCode?: number
  ) {
    super(message);
    this.name = 'BillingProjectionError';
  }
}

function notes(value: unknown): Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function unixDate(value: number | null | undefined): Date | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? new Date(value * 1_000)
    : null;
}

function subscriptionFromEvent(
  event: RazorpayWebhookEvent
): RazorpaySubscriptionEntity | null {
  const entry = event.payload.subscription;
  if (!entry?.entity || typeof entry.entity !== 'object') return null;
  return entry.entity as unknown as RazorpaySubscriptionEntity;
}

async function retrieveSubscription(
  subscriptionId: string
): Promise<RazorpaySubscriptionEntity> {
  try {
    return await razorpayRequest<RazorpaySubscriptionEntity>(
      'GET',
      `/v1/subscriptions/${razorpayPathId(subscriptionId)}`
    );
  } catch (error) {
    if (error instanceof RazorpayApiError) {
      throw new BillingProjectionError(
        'Unable to retrieve canonical Razorpay subscription state',
        error.retryable,
        error.statusCode
      );
    }
    throw error;
  }
}

async function readProjectionRevision(
  subscriptionId: string
): Promise<ProjectionRevision | null> {
  return prisma.subscriptionMirror.findUnique({
    where: {
      billingProvider_externalSubscriptionId: {
        billingProvider: PROVIDER,
        externalSubscriptionId: subscriptionId,
      },
    },
    select: {
      id: true,
      status: true,
      providerStatus: true,
      activeKey: true,
      lastProviderEventId: true,
      lastProviderEventCreatedAt: true,
      updatedAt: true,
    },
  });
}

function sameProjectionRevision(
  existing: {
    id: string;
    status: string;
    providerStatus: string | null;
    activeKey: string | null;
    lastProviderEventId: string | null;
    lastProviderEventCreatedAt: Date | null;
    updatedAt: Date;
  } | null,
  expected: ProjectionRevision | null
): boolean {
  if (!existing || !expected) return existing === null && expected === null;
  return existing.id === expected.id &&
    existing.status === expected.status &&
    existing.providerStatus === expected.providerStatus &&
    existing.activeKey === expected.activeKey &&
    existing.lastProviderEventId === expected.lastProviderEventId &&
    existing.lastProviderEventCreatedAt?.getTime() ===
      expected.lastProviderEventCreatedAt?.getTime() &&
    existing.updatedAt.getTime() === expected.updatedAt.getTime();
}

async function resolveCheckoutIntent(subscription: RazorpaySubscriptionEntity) {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscription.id)) {
    throw new BillingProjectionError(
      'Razorpay subscription event has an invalid identifier',
      false
    );
  }
  const providerNotes = notes(subscription.notes);
  const claimedIntentId = providerNotes.checkoutIntentId;
  const byExternal = await prisma.billingCheckoutSession.findUnique({
    where: {
      billingProvider_externalSessionId: {
        billingProvider: PROVIDER,
        externalSessionId: subscription.id,
      },
    },
  });
  const byClaim = claimedIntentId
    ? await prisma.billingCheckoutSession.findUnique({
      where: { id: claimedIntentId },
    })
    : null;

  if (claimedIntentId && !byClaim) {
    throw new BillingProjectionError(
      'Razorpay subscription references an unknown checkout intent',
      false
    );
  }
  if (byExternal && byClaim && byExternal.id !== byClaim.id) {
    throw new BillingProjectionError(
      'Razorpay subscription maps to conflicting checkout intents',
      false
    );
  }
  const intent = byExternal ?? byClaim;
  if (!intent) {
    throw new BillingProjectionError(
      'Razorpay subscription was not created by this application',
      false
    );
  }
  if (
    intent.billingProvider !== PROVIDER ||
    (intent.externalSessionId && intent.externalSessionId !== subscription.id) ||
    providerNotes.organizationId !== intent.organizationId ||
    providerNotes.planKey !== intent.planKey ||
    providerNotes.checkoutIntentId !== intent.id
  ) {
    throw new BillingProjectionError(
      'Razorpay subscription attribution conflicts with its checkout intent',
      false
    );
  }
  if (['failed', 'expired'].includes(intent.status)) {
    throw new BillingProjectionError(
      'Razorpay subscription references a closed checkout intent',
      false
    );
  }
  return intent;
}

function configuredPlanKey(
  subscription: RazorpaySubscriptionEntity,
  expectedPlanKey: string
): string {
  const mapped = planKeyForRazorpayPlanId(subscription.plan_id);
  if (!mapped || mapped !== expectedPlanKey) {
    throw new BillingProjectionError(
      'Razorpay subscription plan does not match the checkout intent',
      false
    );
  }
  try {
    const plan = requireRazorpayPlan(mapped);
    if (
      subscription.quantity !== plan.quantity ||
      subscription.total_count !== plan.totalCount
    ) {
      throw new BillingProjectionError(
        'Razorpay subscription quantity or cycle count does not match its plan',
        false
      );
    }
  } catch (error) {
    if (error instanceof UnknownBillingPlanError) {
      throw new BillingProjectionError(
        'Razorpay subscription references an unavailable plan',
        false
      );
    }
    throw error;
  }
  return mapped;
}

function normalizedStatus(
  subscription: RazorpaySubscriptionEntity,
  trialDays: number
): string {
  switch (subscription.status) {
    case 'created':
      return 'pending';
    case 'authenticated':
      return trialDays > 0 ? 'trialing' : 'pending';
    case 'active':
      return 'active';
    case 'pending':
      return 'past_due';
    case 'halted':
    case 'paused':
      return 'suspended';
    case 'cancelled':
      return 'canceled';
    case 'completed':
      return 'completed';
    case 'expired':
      return 'expired';
    default:
      throw new BillingProjectionError(
        'Razorpay returned an unsupported subscription status',
        false
      );
  }
}

function accessState(
  status: string,
  eventCreated: Date,
  priorGraceUntil: Date | null,
  paidThrough: Date | null
) {
  if (status === 'active' || status === 'trialing') {
    return {
      organizationStatus: 'active',
      billingStatus: 'active',
      graceUntil: null,
      accessEnabled: true,
    };
  }
  if (status === 'completed' && paidThrough && paidThrough.getTime() > Date.now()) {
    return {
      organizationStatus: 'active',
      billingStatus: 'completed',
      graceUntil: null,
      accessEnabled: true,
    };
  }
  if (status === 'past_due') {
    const graceUntil = priorGraceUntil ?? new Date(
      eventCreated.getTime() +
      getRazorpayRuntimeConfig().gracePeriodDays * 86_400_000
    );
    const graceActive = graceUntil.getTime() > Date.now();
    return {
      organizationStatus: graceActive ? 'past_due_grace' : 'suspended',
      billingStatus: 'past_due',
      graceUntil,
      accessEnabled: graceActive,
    };
  }
  if (status === 'pending') {
    return {
      organizationStatus: 'pending_payment',
      billingStatus: 'pending',
      graceUntil: null,
      accessEnabled: false,
    };
  }
  if (['canceled', 'completed', 'expired'].includes(status)) {
    return {
      organizationStatus: 'canceled',
      billingStatus: status,
      graceUntil: null,
      accessEnabled: false,
    };
  }
  return {
    organizationStatus: 'suspended',
    billingStatus: status,
    graceUntil: null,
    accessEnabled: false,
  };
}

async function materializeEntitlements(
  tx: Prisma.TransactionClient,
  organizationId: string,
  subscriptionMirrorId: string,
  planKey: string,
  accessEnabled: boolean,
  expiresAt: Date | null
) {
  const configured = requireRazorpayPlan(planKey).entitlements;
  const keys = Object.keys(configured);
  await tx.entitlement.deleteMany({
    where: {
      organizationId,
      source: { in: [...BILLING_MANAGED_ENTITLEMENT_SOURCES] },
      ...(keys.length ? { key: { notIn: keys } } : {}),
    },
  });

  for (const [key, value] of Object.entries(configured)) {
    const enabled = accessEnabled && value !== false;
    const limit = typeof value === 'number' ? new Prisma.Decimal(value) : null;
    await tx.entitlement.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: {
        organizationId,
        subscriptionMirrorId,
        key,
        enabled,
        limit,
        value: value as Prisma.InputJsonValue,
        source: 'billing-plan',
        expiresAt,
      },
      update: {
        subscriptionMirrorId,
        enabled,
        limit,
        value: value as Prisma.InputJsonValue,
        source: 'billing-plan',
        effectiveAt: new Date(),
        expiresAt,
      },
    });
  }
}

function validateCustomerId(customerId: string | null) {
  if (!customerId) return;
  if (!/^cust_[A-Za-z0-9]+$/.test(customerId)) {
    throw new BillingProjectionError(
      'Razorpay subscription has an invalid customer identifier',
      false
    );
  }
}

async function projectSubscription(
  intent: Awaited<ReturnType<typeof resolveCheckoutIntent>>,
  subscription: RazorpaySubscriptionEntity,
  metadata: {
    accountId: string | null;
    eventCreated: Date;
  },
  eventId: string,
  expectedRevision: ProjectionRevision | null
) {
  if (
    subscription.entity !== 'subscription' ||
    !CURRENT_PROVIDER_STATUSES.has(subscription.status) &&
      !['cancelled', 'completed', 'expired'].includes(subscription.status)
  ) {
    throw new BillingProjectionError(
      'Invalid canonical Razorpay subscription object',
      false
    );
  }
  const providerNotes = notes(subscription.notes);
  if (
    providerNotes.organizationId !== intent.organizationId ||
    providerNotes.checkoutIntentId !== intent.id
  ) {
    throw new BillingProjectionError(
      'Canonical Razorpay subscription attribution is invalid',
      false
    );
  }

  const account = await prisma.billingAccount.findUnique({
    where: { id: intent.billingAccountId },
  });
  if (
    !account ||
    account.organizationId !== intent.organizationId ||
    account.billingProvider !== PROVIDER ||
    account.activeKey !== 'current'
  ) {
    throw new BillingProjectionError(
      'The Razorpay billing account no longer controls this organization',
      false
    );
  }

  const planKey = configuredPlanKey(subscription, intent.planKey);
  const plan = requireRazorpayPlan(planKey);
  if (account.currency !== plan.currency) {
    throw new BillingProjectionError(
      'Razorpay plan currency conflicts with the billing account',
      false
    );
  }
  const status = normalizedStatus(subscription, plan.trialDays);
  const eventCreated = metadata.eventCreated;
  const trialEnd = status === 'trialing'
    ? unixDate(subscription.start_at)
    : null;
  const currentPeriodStart = status === 'trialing'
    ? intent.checkoutVerifiedAt ?? eventCreated
    : unixDate(subscription.current_start);
  const currentPeriodEnd = status === 'trialing'
    ? trialEnd
    : unixDate(subscription.current_end);
  const paidCompletionIsCurrent = subscription.status === 'completed' &&
    Boolean(currentPeriodEnd && currentPeriodEnd.getTime() > Date.now());
  const providerIsCurrent = CURRENT_PROVIDER_STATUSES.has(subscription.status) ||
    paidCompletionIsCurrent;
  validateCustomerId(subscription.customer_id);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${account.organizationId}`}, 0))::text`;

    const existing = await tx.subscriptionMirror.findUnique({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: PROVIDER,
          externalSubscriptionId: subscription.id,
        },
      },
    });
    if (existing && existing.organizationId !== account.organizationId) {
      throw new BillingProjectionError(
        'Razorpay subscription is already owned by another organization',
        false
      );
    }
    if (!sameProjectionRevision(existing, expectedRevision)) {
      throw new ProjectionRevisionChangedError();
    }

    const competing = await tx.subscriptionMirror.findFirst({
      where: {
        organizationId: account.organizationId,
        activeKey: 'current',
        externalSubscriptionId: { not: subscription.id },
      },
      select: { id: true },
    });
    if (providerIsCurrent && competing) {
      throw new BillingProjectionError(
        'A different subscription already controls this organization',
        false
      );
    }

    const currentIntent = await tx.billingCheckoutSession.findUnique({
      where: { id: intent.id },
    });
    if (!currentIntent || ['failed', 'expired'].includes(currentIntent.status)) {
      throw new BillingProjectionError(
        'Razorpay subscription references a closed checkout intent',
        false
      );
    }

    const access = accessState(
      status,
      eventCreated,
      existing?.graceUntil ?? null,
      currentPeriodEnd
    );
    const wasController = existing?.activeKey === 'current';
    const cancelAtPeriodEnd = providerIsCurrent &&
      existing?.cancelAtPeriodEnd === true;
    const priorPayload = (
      existing?.providerPayload &&
      !Array.isArray(existing.providerPayload) &&
      typeof existing.providerPayload === 'object'
    ) ? existing.providerPayload as Record<string, unknown> : {};
    const cancellationMetadata = Object.fromEntries(
      [
        'cancellationRequestHash',
        'cancellationRequestedByUserId',
        'cancellationMode',
        'cancellationStatus',
        'cancellationRequestedAt',
        'cancellationConfirmedAt',
        'cancellationLastError',
      ]
        .filter(key => typeof priorPayload[key] === 'string')
        .map(key => [key, priorPayload[key]])
    );
    const providerPayload = {
      checkoutIntentId: intent.id,
      planId: subscription.plan_id,
      customerId: subscription.customer_id,
      quantity: subscription.quantity,
      totalCount: subscription.total_count,
      paidCount: subscription.paid_count,
      remainingCount: subscription.remaining_count ?? null,
      hasScheduledChanges: subscription.has_scheduled_changes,
      changeScheduledAt: subscription.change_scheduled_at ?? null,
      scheduleChangeAt: subscription.schedule_change_at ?? null,
      accountId: metadata.accountId,
      ...cancellationMetadata,
    };
    const advancesEventWatermark =
      !existing?.lastProviderEventCreatedAt ||
      existing.lastProviderEventCreatedAt <= eventCreated;
    const lastProviderEventId = advancesEventWatermark
      ? eventId
      : existing?.lastProviderEventId ?? eventId;
    const lastProviderEventCreatedAt = advancesEventWatermark
      ? eventCreated
      : existing?.lastProviderEventCreatedAt ?? eventCreated;

    const mirror = await tx.subscriptionMirror.upsert({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: PROVIDER,
          externalSubscriptionId: subscription.id,
        },
      },
      create: {
        organizationId: account.organizationId,
        billingAccountId: account.id,
        billingProvider: PROVIDER,
        externalSubscriptionId: subscription.id,
        planKey,
        status,
        providerStatus: subscription.status,
        activeKey: providerIsCurrent ? 'current' : null,
        currentPeriodStart,
        currentPeriodEnd,
        trialEnd,
        cancelAtPeriodEnd,
        canceledAt: subscription.status === 'cancelled'
          ? unixDate(subscription.ended_at) ?? eventCreated
          : null,
        graceUntil: access.graceUntil,
        providerPayload,
        lastProviderEventId,
        lastProviderEventCreatedAt,
      },
      update: {
        billingAccountId: account.id,
        planKey,
        status,
        providerStatus: subscription.status,
        activeKey: providerIsCurrent ? 'current' : null,
        currentPeriodStart,
        currentPeriodEnd,
        trialEnd,
        cancelAtPeriodEnd,
        canceledAt: subscription.status === 'cancelled'
          ? unixDate(subscription.ended_at) ?? eventCreated
          : existing?.canceledAt ?? null,
        graceUntil: access.graceUntil,
        providerPayload,
        lastProviderEventId,
        lastProviderEventCreatedAt,
      },
    });

    const controlsTenant = providerIsCurrent || (wasController && !competing);
    if (controlsTenant) {
      if (providerIsCurrent) {
        await tx.billingCheckoutSession.updateMany({
          where: {
            organizationId: account.organizationId,
            billingProvider: PROVIDER,
            activeKey: 'active',
            id: { not: currentIntent.id },
          },
          data: {
            status: 'failed',
            activeKey: null,
            completedAt: new Date(),
            lastError: 'Superseded by an authorized Razorpay subscription',
          },
        });
      }
      await tx.billingAccount.update({
        where: { id: account.id },
        data: { status: access.billingStatus },
      });
      await tx.organization.update({
        where: { id: account.organizationId },
        data: {
          status: access.organizationStatus,
          planTier: planKey,
        },
      });
      await materializeEntitlements(
        tx,
        account.organizationId,
        mirror.id,
        planKey,
        access.accessEnabled,
        status === 'completed' ? currentPeriodEnd : access.graceUntil
      );
    }

    const intentAlreadyCompleted = currentIntent.status === 'completed';
    await tx.billingCheckoutSession.update({
      where: { id: intent.id },
      data: {
        externalSessionId: subscription.id,
        status: intentAlreadyCompleted
          ? 'completed'
          : subscription.status === 'created'
            ? currentIntent.status
            : providerIsCurrent
              ? 'completed'
              : subscription.status === 'expired'
                ? 'expired'
                : 'failed',
        activeKey: intentAlreadyCompleted
          ? null
          : subscription.status === 'created'
            ? currentIntent.activeKey
            : null,
        completedAt: intentAlreadyCompleted || subscription.status !== 'created'
          ? currentIntent.completedAt ?? new Date()
          : currentIntent.completedAt,
        lastError: intentAlreadyCompleted
          ? null
          : ['cancelled', 'expired'].includes(subscription.status)
            ? `Razorpay authorization ended with ${subscription.status}`
            : null,
      },
    });
    return mirror;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function projectLatestCanonicalSubscription(
  intent: Awaited<ReturnType<typeof resolveCheckoutIntent>>,
  subscriptionId: string,
  metadata: {
    accountId: string | null;
    eventCreated: Date;
  },
  eventId: string
) {
  for (
    let attempt = 0;
    attempt < MAX_CANONICAL_PROJECTION_ATTEMPTS;
    attempt += 1
  ) {
    const expectedRevision = await readProjectionRevision(subscriptionId);
    const canonical = await retrieveSubscription(subscriptionId);
    try {
      return await projectSubscription(
        intent,
        canonical,
        metadata,
        eventId,
        expectedRevision
      );
    } catch (error) {
      if (!(error instanceof ProjectionRevisionChangedError)) throw error;
    }
  }

  throw new BillingProjectionError(
    'Subscription projection kept changing during canonical provider reconciliation',
    true
  );
}

export async function projectVerifiedRazorpaySubscription(
  subscription: RazorpaySubscriptionEntity,
  checkoutIntentId: string
) {
  const intent = await resolveCheckoutIntent(subscription);
  if (intent.id !== checkoutIntentId) {
    throw new BillingProjectionError(
      'Canonical Razorpay subscription does not match the verified checkout intent',
      false
    );
  }
  return projectLatestCanonicalSubscription(
    intent,
    subscription.id,
    {
      accountId: getRazorpayRuntimeConfig().accountId ?? null,
      eventCreated: new Date(),
    },
    `checkout-verification:${checkoutIntentId}`
  );
}

export async function processRazorpayEvent(
  event: RazorpayWebhookEvent,
  eventId: string
): Promise<Record<string, unknown>> {
  if (!SUBSCRIPTION_EVENTS.has(event.event)) {
    return { action: 'ignored', eventType: event.event };
  }
  const eventSubscription = subscriptionFromEvent(event);
  if (!eventSubscription) {
    throw new BillingProjectionError(
      'Razorpay subscription event has no subscription payload',
      false
    );
  }
  const intent = await resolveCheckoutIntent(eventSubscription);
  const mirror = await projectLatestCanonicalSubscription(
    intent,
    eventSubscription.id,
    {
      accountId: event.account_id,
      eventCreated: new Date(event.created_at * 1_000),
    },
    eventId
  );
  return {
    action: 'subscription_projected',
    organizationId: mirror.organizationId,
    subscriptionMirrorId: mirror.id,
  };
}
