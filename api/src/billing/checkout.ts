import crypto from 'node:crypto';
import {
  Prisma,
  type BillingCancellationAttempt,
  type SubscriptionMirror,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  getRazorpayRuntimeConfig,
  requireRazorpayPlan,
  type RazorpayPlan,
} from './config';
import {
  RazorpayApiError,
  razorpayHasPendingSubscriptionUpdate,
  razorpayPathId,
  razorpayRequest,
  type RazorpayPlanEntity,
  type RazorpaySubscriptionEntity,
  verifyRazorpayCheckoutSignature,
} from './razorpayClient';
import { projectVerifiedRazorpaySubscription } from './projection';
import { BILLING_MANAGED_ENTITLEMENT_SOURCES } from './access';

const PROVIDER = 'razorpay';
const validatedPlans = new Map<string, number>();

export type IdempotencyKeyDisposition = 'reuse' | 'replace';

export class BillingConflictError extends Error {
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly idempotencyKeyDisposition?: IdempotencyKeyDisposition
  ) {
    super(message);
    this.name = 'BillingConflictError';
  }
}

export class BillingCheckoutVerificationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BillingCheckoutVerificationError';
  }
}

function checkoutRequestHash(organizationId: string, requestIdempotencyKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`razorpay-checkout\0${organizationId}\0${requestIdempotencyKey}`)
    .digest('hex');
}

type CancellationMode = 'immediate' | 'period_end';
type CancellationStatus = 'submitting' | 'confirmed' | 'failed';
const CANCELLATION_RECONCILIATION_TIMEOUT_MS = 5 * 60_000;
const CANCELLATION_RETRY_BASE_MS = 60_000;
const CANCELLATION_RETRY_MAX_MS = 60 * 60_000;
const CANCELLATION_REVIEW_RETRY_MS = 6 * 60 * 60_000;
const CANCELLATION_PROCESSING_STALE_MS = 5 * 60_000;

interface CancellationClaim {
  requestHash: string;
  requestedByUserId: string;
  mode: CancellationMode;
  status: CancellationStatus;
}

function cancellationRequestHash(
  organizationId: string,
  requestIdempotencyKey: string
): string {
  return crypto
    .createHash('sha256')
    .update(`razorpay-cancellation\0${organizationId}\0${requestIdempotencyKey}`)
    .digest('hex');
}

function notes(value: unknown): Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function cancellationClaim(value: Prisma.JsonValue | null): CancellationClaim | null {
  const payload = jsonObject(value);
  const requestHash = payload.cancellationRequestHash;
  const requestedByUserId = payload.cancellationRequestedByUserId;
  const mode = payload.cancellationMode;
  const status = payload.cancellationStatus;
  if (
    typeof requestHash !== 'string' ||
    typeof requestedByUserId !== 'string' ||
    requestedByUserId.length === 0 ||
    !['immediate', 'period_end'].includes(String(mode)) ||
    !['submitting', 'confirmed', 'failed'].includes(String(status))
  ) {
    return null;
  }
  return {
    requestHash,
    requestedByUserId,
    mode: mode as CancellationMode,
    status: status as CancellationStatus,
  };
}

function providerPayload(
  existing: Prisma.JsonValue | null,
  subscription: RazorpaySubscriptionEntity,
  cancellation: {
    requestHash: string;
    requestedByUserId: string;
    mode: CancellationMode;
    status: CancellationStatus;
    requestedAt: string;
    confirmedAt?: string;
    lastError?: string;
  }
): Prisma.InputJsonObject {
  return {
    ...jsonObject(existing),
    planId: subscription.plan_id,
    customerId: subscription.customer_id,
    quantity: subscription.quantity,
    totalCount: subscription.total_count,
    paidCount: subscription.paid_count,
    remainingCount: subscription.remaining_count ?? null,
    hasScheduledChanges: subscription.has_scheduled_changes,
    changeScheduledAt: subscription.change_scheduled_at ?? null,
    scheduleChangeAt: subscription.schedule_change_at ?? null,
    cancellationRequestHash: cancellation.requestHash,
    cancellationRequestedByUserId: cancellation.requestedByUserId,
    cancellationMode: cancellation.mode,
    cancellationStatus: cancellation.status,
    cancellationRequestedAt: cancellation.requestedAt,
    cancellationConfirmedAt: cancellation.confirmedAt ?? '',
    cancellationLastError: cancellation.lastError ?? '',
  } as Prisma.InputJsonObject;
}

function unixDate(value: number | null | undefined): Date | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? new Date(value * 1_000)
    : null;
}

async function validateRazorpayPlan(planKey: string, configured: RazorpayPlan): Promise<void> {
  const cacheKey = [
    planKey,
    configured.planId,
    configured.amountMinor,
    configured.currency,
    configured.period,
    configured.interval,
  ].join(':');
  if ((validatedPlans.get(cacheKey) ?? 0) > Date.now()) return;

  const canonical = await razorpayRequest<RazorpayPlanEntity>(
    'GET',
    `/v1/plans/${razorpayPathId(configured.planId)}`
  );
  if (
    canonical.id !== configured.planId ||
    canonical.entity !== 'plan' ||
    canonical.item?.active !== true ||
    canonical.item.amount !== configured.amountMinor ||
    canonical.item.currency?.toUpperCase() !== configured.currency ||
    canonical.period !== configured.period ||
    canonical.interval !== configured.interval
  ) {
    throw new BillingConflictError(
      `Razorpay plan ${planKey} does not match the immutable application configuration`
    );
  }
  validatedPlans.set(cacheKey, Date.now() + 10 * 60_000);
}

async function organizationForCheckout(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      billingAccounts: true,
    },
  });
  if (!organization) throw new Error('Organization not found');
  return organization;
}

export async function ensureRazorpayBillingAccount(
  organizationId: string,
  currency: string
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${organizationId}`}, 0))::text`;

    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, email: true },
    });
    if (!organization) throw new Error('Organization not found');

    const accounts = await tx.billingAccount.findMany({
      where: { organizationId },
    });
    const controller = accounts.find(account => account.activeKey === 'current');
    if (controller && controller.billingProvider !== PROVIDER) {
      throw new BillingConflictError(
        'A different billing provider controls this organization; an audited operator cutover is required before Razorpay checkout'
      );
    }

    const existing = accounts.find(account => account.billingProvider === PROVIDER);
    if (existing) {
      if (existing.currency !== currency) {
        throw new BillingConflictError(
          'The organization billing currency does not match the requested plan'
        );
      }
      if (existing.activeKey === 'current') return existing;
      return tx.billingAccount.update({
        where: { id: existing.id },
        data: { activeKey: 'current' },
      });
    }

    return tx.billingAccount.create({
      data: {
        organizationId,
        billingProvider: PROVIDER,
        activeKey: 'current',
        externalCustomerId: null,
        status: 'pending',
        billingEmail: organization.email,
        currency,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export interface RazorpayCheckoutIntent {
  provider: 'razorpay';
  checkoutIntentId: string;
  keyId: string;
  subscriptionId: string;
  merchantName: string;
  description: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  themeColor?: string;
}

type CheckoutSessionRecord = NonNullable<
  Awaited<ReturnType<typeof prisma.billingCheckoutSession.findFirst>>
>;

interface RazorpaySubscriptionCollection {
  entity: 'collection';
  count: number;
  items: RazorpaySubscriptionEntity[];
}

interface CheckoutReconciliationOptions {
  throwWhenPending?: boolean;
  throwWhenProjected?: boolean;
}

function checkoutResponse(input: {
  intentId: string;
  subscriptionId: string;
  organization: Awaited<ReturnType<typeof organizationForCheckout>>;
  planKey: string;
  plan: RazorpayPlan;
}): RazorpayCheckoutIntent {
  const config = getRazorpayRuntimeConfig();
  const prefill = {
    ...(input.organization.name ? { name: input.organization.name } : {}),
    ...(input.organization.email ? { email: input.organization.email } : {}),
    ...(input.organization.phone ? { contact: input.organization.phone } : {}),
  };
  return {
    provider: PROVIDER,
    checkoutIntentId: input.intentId,
    keyId: config.keyId,
    subscriptionId: input.subscriptionId,
    merchantName: config.checkoutName,
    description: input.plan.description ??
      input.plan.name ??
      `${input.planKey} subscription`,
    ...(Object.keys(prefill).length ? { prefill } : {}),
    themeColor: '#2563eb',
  };
}

async function recoverCreatingCheckout(
  intent: CheckoutSessionRecord,
  organization: Awaited<ReturnType<typeof organizationForCheckout>>,
  planKey: string,
  plan: RazorpayPlan,
  options: CheckoutReconciliationOptions = {}
): Promise<RazorpayCheckoutIntent | null> {
  const matches: RazorpaySubscriptionEntity[] = [];
  const from = Math.max(0, Math.floor(intent.createdAt.getTime() / 1_000) - 300);
  const to = Math.min(
    Math.floor(Date.now() / 1_000) + 60,
    Math.floor(intent.createdAt.getTime() / 1_000) + 15 * 60
  );
  let completeSearch = false;

  for (let skip = 0; skip < 500; skip += 100) {
    const page = await razorpayRequest<RazorpaySubscriptionCollection>(
      'GET',
      '/v1/subscriptions',
      {
        query: [
          ['plan_id', plan.planId],
          ['from', from],
          ['to', to],
          ['count', 100],
          ['skip', skip],
        ],
      }
    );
    if (
      page.entity !== 'collection' ||
      !Number.isSafeInteger(page.count) ||
      !Array.isArray(page.items)
    ) {
      throw new BillingConflictError(
        'Razorpay subscription reconciliation returned an invalid response'
      );
    }
    for (const subscription of page.items) {
      const providerNotes = notes(subscription.notes);
      if (
        providerNotes.organizationId === intent.organizationId &&
        providerNotes.planKey === intent.planKey &&
        providerNotes.checkoutIntentId === intent.id
      ) {
        matches.push(subscription);
      }
    }
    if (page.items.length < 100) {
      completeSearch = true;
      break;
    }
  }
  if (!completeSearch) {
    throw new BillingConflictError(
      'Razorpay reconciliation exceeded its safe search window; billing requires operator review'
    );
  }

  if (matches.length > 1) {
    throw new BillingConflictError(
      'Multiple Razorpay subscriptions match one checkout intent; billing requires operator review'
    );
  }
  const subscription = matches[0];
  if (subscription) {
    validateCanonicalSubscription(subscription, {
      organizationId: intent.organizationId,
      intentId: intent.id,
      plan,
      planKey,
      subscriptionId: subscription.id,
    });
    const providerStillAwaitingAuthorization = subscription.status === 'created';
    const providerAlreadyAuthorized = [
      'authenticated',
      'active',
      'pending',
      'halted',
      'paused',
      'completed',
    ].includes(subscription.status);
    await prisma.billingCheckoutSession.updateMany({
      where: {
        id: intent.id,
        status: 'creating',
        activeKey: 'active',
      },
      data: providerStillAwaitingAuthorization
        ? {
            externalSessionId: subscription.id,
            status: 'open',
            lastError: null,
          }
        : providerAlreadyAuthorized
          ? {
              externalSessionId: subscription.id,
              status: 'verified',
              lastError: 'Authorization recovered; awaiting signed webhook projection',
            }
          : {
              externalSessionId: subscription.id,
              status: subscription.status === 'expired' ? 'expired' : 'failed',
              activeKey: null,
              completedAt: new Date(),
              lastError: `Recovered Razorpay subscription is ${subscription.status}`,
            },
    });

    if (providerAlreadyAuthorized) {
      await projectVerifiedRazorpaySubscription(subscription, intent.id);
      if (options.throwWhenProjected !== false) {
        throw new BillingConflictError(
          'Razorpay authorization was recovered and the subscription is already active'
        );
      }
      return null;
    }
    if (!providerStillAwaitingAuthorization) return null;
    return checkoutResponse({
      intentId: intent.id,
      subscriptionId: subscription.id,
      organization,
      planKey,
      plan,
    });
  }

  if (intent.expiresAt.getTime() > Date.now()) {
    if (options.throwWhenPending !== false) {
      throw new BillingConflictError(
        'Subscription creation is awaiting provider reconciliation; do not retry yet',
        'reuse'
      );
    }
    return null;
  }
  await prisma.billingCheckoutSession.updateMany({
    where: {
      id: intent.id,
      status: 'creating',
      activeKey: 'active',
    },
    data: {
      status: 'failed',
      activeKey: null,
      completedAt: new Date(),
      lastError: 'No Razorpay subscription was found after the reconciliation window',
    },
  });
  return null;
}

async function reconcileOpenCheckout(
  intent: CheckoutSessionRecord,
  organization: Awaited<ReturnType<typeof organizationForCheckout>>,
  planKey: string,
  plan: RazorpayPlan,
  options: CheckoutReconciliationOptions = {}
): Promise<RazorpayCheckoutIntent | null> {
  if (!intent.externalSessionId) {
    throw new BillingConflictError('The open checkout intent has no provider subscription');
  }
  const subscription = await razorpayRequest<RazorpaySubscriptionEntity>(
    'GET',
    `/v1/subscriptions/${razorpayPathId(intent.externalSessionId)}`
  );
  validateCanonicalSubscription(subscription, {
    organizationId: intent.organizationId,
    intentId: intent.id,
    plan,
    planKey,
    subscriptionId: intent.externalSessionId,
  });

  if (subscription.status === 'created') {
    const providerExpiry = unixDate(subscription.expire_by);
    if (
      intent.expiresAt.getTime() > Date.now() ||
      !providerExpiry ||
      providerExpiry.getTime() > Date.now()
    ) {
      return checkoutResponse({
        intentId: intent.id,
        subscriptionId: subscription.id,
        organization,
        planKey,
        plan,
      });
    }
    await prisma.billingCheckoutSession.updateMany({
      where: {
        id: intent.id,
        status: { in: ['open', 'verified'] },
        activeKey: 'active',
      },
      data: {
        status: 'expired',
        activeKey: null,
        completedAt: new Date(),
        lastError: 'Razorpay authorization window expired',
      },
    });
    return null;
  }

  if (
    ['authenticated', 'active', 'pending', 'halted', 'paused', 'completed'].includes(
      subscription.status
    )
  ) {
    await prisma.billingCheckoutSession.updateMany({
      where: {
        id: intent.id,
        status: { in: ['open', 'verified'] },
        activeKey: 'active',
      },
      data: {
        status: 'verified',
        lastError: null,
      },
    });
    await projectVerifiedRazorpaySubscription(subscription, intent.id);
    if (options.throwWhenProjected !== false) {
      throw new BillingConflictError(
        'Razorpay authorization is already active; do not create another subscription'
      );
    }
    return null;
  }

  await prisma.billingCheckoutSession.updateMany({
    where: {
      id: intent.id,
      status: { in: ['open', 'verified'] },
      activeKey: 'active',
    },
    data: {
      status: subscription.status === 'expired' ? 'expired' : 'failed',
      activeKey: null,
      completedAt: new Date(),
      lastError: `Razorpay authorization ended with ${subscription.status}`,
    },
  });
  return null;
}

/**
 * Recovers Razorpay subscription authorizations when the browser verification
 * callback or an authentication webhook is delayed or lost.
 */
export async function reconcileStaleRazorpayCheckoutSessions(
  limit = 100,
  now = new Date()
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(
      'Razorpay checkout reconciliation batch limit must be between 1 and 500'
    );
  }
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const intents = await prisma.billingCheckoutSession.findMany({
    where: {
      billingProvider: PROVIDER,
      activeKey: 'active',
      updatedAt: { lte: staleBefore },
      OR: [
        { status: 'creating' },
        {
          status: { in: ['open', 'verified'] },
          externalSessionId: { not: null },
        },
      ],
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });

  let stillPending = 0;
  const failures: unknown[] = [];
  for (const intent of intents) {
    try {
      const organization = await organizationForCheckout(intent.organizationId);
      const plan = requireRazorpayPlan(intent.planKey);
      const checkout = intent.status === 'creating'
        ? await recoverCreatingCheckout(
            intent,
            organization,
            intent.planKey,
            plan,
            { throwWhenPending: false, throwWhenProjected: false }
          )
        : await reconcileOpenCheckout(
            intent,
            organization,
            intent.planKey,
            plan,
            { throwWhenProjected: false }
          );
      if (checkout) stillPending += 1;

      // Rate-limit provider polling for authorizations that remain open.
      await prisma.billingCheckoutSession.updateMany({
        where: { id: intent.id, activeKey: 'active' },
        data: { updatedAt: now },
      });
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const error = new Error(
      `Razorpay checkout reconciliation failed for ${failures.length} of ${intents.length} authorizations`
    ) as Error & { cause?: unknown };
    error.name = 'RazorpayCheckoutReconciliationError';
    error.cause = failures[0];
    throw error;
  }

  return {
    examined: intents.length,
    stillPending,
  };
}

export async function createRazorpayCheckoutSession(input: {
  organizationId: string;
  planKey: string;
  requestIdempotencyKey: string;
}): Promise<RazorpayCheckoutIntent> {
  const plan = requireRazorpayPlan(input.planKey);
  const config = getRazorpayRuntimeConfig();
  await validateRazorpayPlan(input.planKey, plan);
  const organization = await organizationForCheckout(input.organizationId);
  const account = await ensureRazorpayBillingAccount(input.organizationId, plan.currency);
  const requestKeyHash = checkoutRequestHash(
    input.organizationId,
    input.requestIdempotencyKey
  );
  const requestedExpiresAt = new Date(
    Date.now() + config.subscriptionAuthTtlMinutes * 60_000
  );

  const activeBeforeClaim = await prisma.billingCheckoutSession.findFirst({
    where: {
      organizationId: input.organizationId,
      billingProvider: PROVIDER,
      activeKey: 'active',
    },
  });
  if (activeBeforeClaim) {
    const activePlan = requireRazorpayPlan(activeBeforeClaim.planKey);
    let recovered: RazorpayCheckoutIntent | null = null;
    if (activeBeforeClaim.status === 'creating') {
      recovered = await recoverCreatingCheckout(
        activeBeforeClaim,
        organization,
        activeBeforeClaim.planKey,
        activePlan
      );
    } else if (
      ['open', 'verified'].includes(activeBeforeClaim.status) &&
      activeBeforeClaim.externalSessionId
    ) {
      recovered = await reconcileOpenCheckout(
        activeBeforeClaim,
        organization,
        activeBeforeClaim.planKey,
        activePlan
      );
    } else {
      throw new BillingConflictError(
        'A subscription authorization is already awaiting billing projection'
      );
    }
    if (recovered) {
      if (activeBeforeClaim.planKey !== input.planKey) {
        throw new BillingConflictError(
          'Another subscription authorization is already open for a different plan'
        );
      }
      return recovered;
    }
  }

  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${input.organizationId}`}, 0))::text`;

    const existingSubscription = await tx.subscriptionMirror.findFirst({
      where: {
        organizationId: input.organizationId,
        activeKey: 'current',
      },
      select: { billingProvider: true },
    });
    if (existingSubscription) {
      throw new BillingConflictError(
        existingSubscription.billingProvider === PROVIDER
          ? 'A subscription already exists for this organization'
          : 'A different billing provider still controls this organization'
      );
    }

    const activeIntent = await tx.billingCheckoutSession.findFirst({
      where: {
        organizationId: input.organizationId,
        billingProvider: PROVIDER,
        activeKey: 'active',
      },
    });
    if (activeIntent) {
      if (activeIntent.planKey !== input.planKey) {
        throw new BillingConflictError(
          'Another subscription authorization is already open for a different plan'
        );
      }
      if (activeIntent.status === 'open' && activeIntent.externalSessionId) {
        return { intent: activeIntent, created: false };
      }
      if (activeIntent.requestKeyHash !== requestKeyHash) {
        throw new BillingConflictError(
          'Another subscription authorization is already open for this organization'
        );
      }
      return { intent: activeIntent, created: false };
    }

    const priorRequest = await tx.billingCheckoutSession.findUnique({
      where: {
        organizationId_billingProvider_requestKeyHash: {
          organizationId: input.organizationId,
          billingProvider: PROVIDER,
          requestKeyHash,
        },
      },
    });
    if (priorRequest) {
      if (priorRequest.planKey !== input.planKey) {
        throw new BillingConflictError(
          'This idempotency key was already used for another plan',
          'replace'
        );
      }
      throw new BillingConflictError(
        'This Checkout request is no longer reusable; start Checkout again',
        'replace'
      );
    }

    const intent = await tx.billingCheckoutSession.create({
      data: {
        organizationId: input.organizationId,
        billingAccountId: account.id,
        billingProvider: PROVIDER,
        requestKeyHash,
        planKey: input.planKey,
        status: 'creating',
        activeKey: 'active',
        expiresAt: requestedExpiresAt,
      },
    });
    return { intent, created: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  if (!claimed.created) {
    if (claimed.intent.status === 'open' && claimed.intent.externalSessionId) {
      return checkoutResponse({
        intentId: claimed.intent.id,
        subscriptionId: claimed.intent.externalSessionId,
        organization,
        planKey: input.planKey,
        plan,
      });
    }
    // Razorpay does not provide a general idempotency key for subscription
    // creation. Retrying an ambiguous POST could create a second mandate.
    throw new BillingConflictError(
      'Subscription creation is awaiting provider reconciliation; do not retry yet'
    );
  }

  const stillClaimed = await prisma.billingCheckoutSession.findFirst({
    where: {
      id: claimed.intent.id,
      status: 'creating',
      activeKey: 'active',
    },
    select: { id: true },
  });
  if (!stillClaimed) {
    throw new BillingConflictError(
      'This checkout intent was superseded before provider creation'
    );
  }

  const expireBy = Math.floor(claimed.intent.expiresAt.getTime() / 1_000);
  const body: Record<string, unknown> = {
    plan_id: plan.planId,
    total_count: plan.totalCount,
    quantity: plan.quantity,
    customer_notify: plan.customerNotify,
    expire_by: expireBy,
    notes: {
      organizationId: input.organizationId,
      planKey: input.planKey,
      checkoutIntentId: claimed.intent.id,
    },
  };
  if (plan.trialDays > 0) {
    body.start_at = Math.floor(
      (Date.now() + plan.trialDays * 86_400_000) / 1_000
    );
  }

  try {
    const subscription = await razorpayRequest<RazorpaySubscriptionEntity>(
      'POST',
      '/v1/subscriptions',
      { body }
    );
    const providerNotes = notes(subscription.notes);
    if (
      !/^sub_[A-Za-z0-9]+$/.test(subscription.id) ||
      subscription.entity !== 'subscription' ||
      subscription.plan_id !== plan.planId ||
      subscription.quantity !== plan.quantity ||
      subscription.total_count !== plan.totalCount ||
      providerNotes.organizationId !== input.organizationId ||
      providerNotes.planKey !== input.planKey ||
      providerNotes.checkoutIntentId !== claimed.intent.id
    ) {
      throw new Error('Razorpay returned a subscription with conflicting attribution');
    }

    const updated = await prisma.billingCheckoutSession.updateMany({
      where: {
        id: claimed.intent.id,
        status: 'creating',
        activeKey: 'active',
      },
      data: {
        externalSessionId: subscription.id,
        status: 'open',
        lastError: null,
      },
    });
    if (updated.count !== 1) {
      throw new BillingConflictError(
        'The subscription was created but its local authorization intent changed'
      );
    }

    return checkoutResponse({
      intentId: claimed.intent.id,
      subscriptionId: subscription.id,
      organization,
      planKey: input.planKey,
      plan,
    });
  } catch (error) {
    const definitiveRejection = error instanceof RazorpayApiError &&
      !error.retryable &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    await prisma.billingCheckoutSession.updateMany({
      where: { id: claimed.intent.id, status: 'creating' },
      data: {
        status: definitiveRejection ? 'failed' : 'creating',
        activeKey: definitiveRejection ? null : 'active',
        lastError: (
          error instanceof Error ? error.message : 'Subscription creation failed'
        ).slice(0, 500),
      },
    });
    if (!definitiveRejection) {
      const currentIntent = await prisma.billingCheckoutSession.findUnique({
        where: { id: claimed.intent.id },
      });
      if (currentIntent?.status === 'creating' && currentIntent.activeKey === 'active') {
        const recovered = await recoverCreatingCheckout(
          currentIntent,
          organization,
          input.planKey,
          plan
        );
        if (recovered) return recovered;
      }
    }
    throw error;
  }
}

function validateCanonicalSubscription(
  subscription: RazorpaySubscriptionEntity,
  input: {
    organizationId: string;
    intentId: string;
    plan: RazorpayPlan;
    planKey: string;
    subscriptionId: string;
  }
) {
  const providerNotes = notes(subscription.notes);
  if (
    subscription.id !== input.subscriptionId ||
    subscription.entity !== 'subscription' ||
    subscription.plan_id !== input.plan.planId ||
    subscription.quantity !== input.plan.quantity ||
    subscription.total_count !== input.plan.totalCount ||
    providerNotes.organizationId !== input.organizationId ||
    providerNotes.planKey !== input.planKey ||
    providerNotes.checkoutIntentId !== input.intentId
  ) {
    throw new BillingCheckoutVerificationError(
      'Razorpay subscription attribution could not be verified'
    );
  }
}

export async function verifyRazorpayCheckout(input: {
  organizationId: string;
  checkoutIntentId: string;
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
  razorpaySignature: string;
}) {
  const intent = await prisma.billingCheckoutSession.findFirst({
    where: {
      id: input.checkoutIntentId,
      organizationId: input.organizationId,
      billingProvider: PROVIDER,
    },
  });
  if (!intent || !intent.externalSessionId) {
    throw new BillingCheckoutVerificationError(
      'The subscription authorization intent was not found'
    );
  }
  if (!['open', 'verified', 'completed'].includes(intent.status)) {
    throw new BillingCheckoutVerificationError(
      'The subscription authorization intent is no longer verifiable'
    );
  }
  if (intent.externalSessionId !== input.razorpaySubscriptionId) {
    throw new BillingCheckoutVerificationError(
      'The subscription identifier does not match the server authorization intent'
    );
  }
  if (
    !verifyRazorpayCheckoutSignature({
      paymentId: input.razorpayPaymentId,
      expectedSubscriptionId: intent.externalSessionId,
      signature: input.razorpaySignature,
    })
  ) {
    throw new BillingCheckoutVerificationError(
      'Razorpay Checkout signature verification failed'
    );
  }

  const plan = requireRazorpayPlan(intent.planKey);
  const subscription = await razorpayRequest<RazorpaySubscriptionEntity>(
    'GET',
    `/v1/subscriptions/${razorpayPathId(intent.externalSessionId)}`
  );
  validateCanonicalSubscription(subscription, {
    organizationId: input.organizationId,
    intentId: intent.id,
    plan,
    planKey: intent.planKey,
    subscriptionId: intent.externalSessionId,
  });
  if (
    !['authenticated', 'active', 'pending', 'halted', 'paused', 'completed'].includes(
      subscription.status
    )
  ) {
    throw new BillingCheckoutVerificationError(
      `Razorpay subscription is not authorized (${subscription.status})`
    );
  }

  const transitioned = await prisma.billingCheckoutSession.updateMany({
    where: {
      id: intent.id,
      status: { in: ['open', 'verified'] },
      externalSessionId: input.razorpaySubscriptionId,
    },
    data: {
      externalPaymentId: input.razorpayPaymentId,
      checkoutVerifiedAt: new Date(),
      status: 'verified',
      lastError: null,
    },
  });
  if (transitioned.count !== 1) {
    const completedTransition = await prisma.billingCheckoutSession.updateMany({
      where: {
        id: intent.id,
        status: 'completed',
        externalSessionId: input.razorpaySubscriptionId,
        externalPaymentId: null,
      },
      data: {
        externalPaymentId: input.razorpayPaymentId,
        checkoutVerifiedAt: new Date(),
        lastError: null,
      },
    });
    if (completedTransition.count !== 1) {
      const current = await prisma.billingCheckoutSession.findUnique({
        where: { id: intent.id },
        select: { status: true, externalPaymentId: true },
      });
      if (
        current?.status !== 'completed' ||
        current.externalPaymentId !== input.razorpayPaymentId
      ) {
        throw new BillingConflictError(
          'The subscription authorization changed while it was being verified'
        );
      }
    }
  }
  const mirror = await projectVerifiedRazorpaySubscription(subscription, intent.id);
  return {
    accepted: true,
    subscriptionId: subscription.id,
    providerStatus: subscription.status,
    subscriptionStatus: mirror.status,
  };
}

function validateCancellationSubscription(
  subscription: RazorpaySubscriptionEntity,
  mirror: SubscriptionMirror
): void {
  const plan = requireRazorpayPlan(mirror.planKey);
  const providerNotes = notes(subscription.notes);
  const expectedCheckoutIntentId =
    jsonObject(mirror.providerPayload).checkoutIntentId;
  if (
    subscription.id !== mirror.externalSubscriptionId ||
    subscription.entity !== 'subscription' ||
    subscription.plan_id !== plan.planId ||
    subscription.quantity !== plan.quantity ||
    subscription.total_count !== plan.totalCount ||
    providerNotes.organizationId !== mirror.organizationId ||
    providerNotes.planKey !== mirror.planKey ||
    typeof expectedCheckoutIntentId !== 'string' ||
    !expectedCheckoutIntentId ||
    providerNotes.checkoutIntentId !== expectedCheckoutIntentId
  ) {
    throw new BillingConflictError(
      'Razorpay cancellation state could not be attributed to the current subscription'
    );
  }
}

function cancellationModeFor(
  subscription: RazorpaySubscriptionEntity
): CancellationMode {
  if (['created', 'authenticated'].includes(subscription.status)) {
    return 'immediate';
  }
  if (!['active', 'pending', 'halted', 'paused'].includes(subscription.status)) {
    throw new BillingConflictError(
      `This subscription cannot be cancelled while it is ${subscription.status}`
    );
  }
  if (!subscription.current_start || !subscription.current_end) {
    throw new BillingConflictError(
      'Razorpay returned an incomplete active billing cycle; cancellation requires operator review'
    );
  }
  if (
    typeof subscription.remaining_count === 'number' &&
    subscription.remaining_count <= 1
  ) {
    throw new BillingConflictError(
      'This subscription is already in its final billing cycle and has no later renewal to cancel'
    );
  }
  return 'period_end';
}

function confirmedCancellationResult(
  mirror: SubscriptionMirror,
  mode: CancellationMode
) {
  return {
    subscriptionId: mirror.externalSubscriptionId,
    cancelAtPeriodEnd: mode === 'period_end',
    cancellationMode: mode,
    currentPeriodEnd: mode === 'period_end' ? mirror.currentPeriodEnd : null,
  };
}

async function cancellationWasApplied(
  subscription: RazorpaySubscriptionEntity,
  mode: CancellationMode
): Promise<boolean> {
  if (subscription.status === 'cancelled') return true;
  if (mode === 'immediate') return false;
  if (
    subscription.has_scheduled_changes !== true ||
    subscription.schedule_change_at !== 'cycle_end'
  ) {
    return false;
  }

  // `has_scheduled_changes` also represents scheduled plan/quantity updates.
  // Only the absence of a pending PATCH update lets us attribute this generic
  // state to the cycle-end cancellation requested by this application.
  return !(await razorpayHasPendingSubscriptionUpdate(subscription.id));
}

function assertCancellationActor(
  claim: { requestedByUserId: string },
  requestedByUserId: string
): void {
  if (claim.requestedByUserId !== requestedByUserId) {
    throw new BillingConflictError(
      'This cancellation Idempotency-Key belongs to a different user',
      'replace'
    );
  }
}

async function applyConfirmedCancellation(
  attempt: Pick<
    BillingCancellationAttempt,
    | 'id'
    | 'organizationId'
    | 'subscriptionMirrorId'
    | 'billingProvider'
    | 'requestHash'
    | 'requestedByUserId'
    | 'mode'
    | 'requestedAt'
    | 'status'
    | 'leaseToken'
  >,
  subscription: RazorpaySubscriptionEntity,
) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${attempt.organizationId}`}, 0))::text`;

    const current = await tx.subscriptionMirror.findUnique({
      where: { id: attempt.subscriptionMirrorId },
    });
    if (
      !current ||
      current.organizationId !== attempt.organizationId ||
      current.billingProvider !== PROVIDER
    ) {
      throw new BillingConflictError('The Razorpay subscription no longer exists');
    }
    validateCancellationSubscription(subscription, current);

    const [currentAttempt, activeAttempt, controllingAccount, competing] =
      await Promise.all([
        tx.billingCancellationAttempt.findUnique({
          where: { id: attempt.id },
        }),
        tx.billingCancellationAttempt.findFirst({
          where: {
            subscriptionMirrorId: current.id,
            activeKey: 'active',
            id: { not: attempt.id },
          },
          select: { id: true },
        }),
      tx.billingAccount.findFirst({
        where: {
          organizationId: attempt.organizationId,
          activeKey: 'current',
        },
        select: { id: true },
      }),
      tx.subscriptionMirror.findFirst({
        where: {
          organizationId: attempt.organizationId,
          activeKey: 'current',
          id: { not: current.id },
        },
        select: { id: true },
      }),
      ]);
    if (
      !currentAttempt ||
      currentAttempt.organizationId !== attempt.organizationId ||
      currentAttempt.subscriptionMirrorId !== current.id ||
      currentAttempt.billingProvider !== PROVIDER ||
      currentAttempt.requestHash !== attempt.requestHash ||
      currentAttempt.requestedByUserId !== attempt.requestedByUserId ||
      currentAttempt.mode !== attempt.mode ||
      currentAttempt.requestedAt.getTime() !== attempt.requestedAt.getTime() ||
      currentAttempt.status !== attempt.status ||
      currentAttempt.leaseToken !== attempt.leaseToken ||
      !['submitting', 'processing', 'confirmed'].includes(attempt.status) ||
      activeAttempt
    ) {
      throw new BillingConflictError(
        'The cancellation claim changed during provider reconciliation'
      );
    }
    const mode = attempt.mode as CancellationMode;
    const confirmedAt = currentAttempt.confirmedAt ?? now;
    if (currentAttempt.status !== 'confirmed') {
      const transitioned = await tx.billingCancellationAttempt.updateMany({
        where: {
          id: currentAttempt.id,
          activeKey: 'active',
          status: currentAttempt.status,
          leaseToken: currentAttempt.leaseToken,
        },
        data: {
          status: 'confirmed',
          activeKey: null,
          confirmedAt,
          nextAttemptAt: null,
          processingStartedAt: null,
          leaseToken: null,
          lastError: null,
        },
      });
      if (transitioned.count !== 1) {
        throw new BillingConflictError(
          'The cancellation claim changed during provider reconciliation'
        );
      }
    }

    const controlsTenant =
      controllingAccount?.id === current.billingAccountId &&
      (current.activeKey === 'current' || !competing);
    const providerEnded = subscription.status === 'cancelled';
    const accessEnded = mode === 'immediate' || providerEnded;
    const updated = await tx.subscriptionMirror.update({
      where: { id: current.id },
      data: {
        status: accessEnded ? 'canceled' : current.status,
        providerStatus: subscription.status,
        activeKey: accessEnded ? null : current.activeKey,
        currentPeriodStart: unixDate(subscription.current_start) ??
          current.currentPeriodStart,
        currentPeriodEnd: unixDate(subscription.current_end) ??
          current.currentPeriodEnd,
        trialEnd: accessEnded ? null : current.trialEnd,
        cancelAtPeriodEnd: mode === 'period_end' && !providerEnded,
        canceledAt: accessEnded
          ? unixDate(subscription.ended_at) ?? now
          : current.canceledAt,
        graceUntil: accessEnded ? null : current.graceUntil,
        providerPayload: providerPayload(
          current.providerPayload,
          subscription,
          {
            requestHash: attempt.requestHash,
            requestedByUserId: attempt.requestedByUserId,
            mode,
            requestedAt: attempt.requestedAt.toISOString(),
            status: 'confirmed',
            confirmedAt: confirmedAt.toISOString(),
          }
        ),
        lastProviderEventId: `cancellation-confirmed:${attempt.requestHash}`,
        lastProviderEventCreatedAt: now,
      },
    });

    if (accessEnded && controlsTenant) {
      await tx.billingAccount.update({
        where: { id: current.billingAccountId },
        data: { status: 'canceled' },
      });
      await tx.organization.update({
        where: { id: current.organizationId },
        data: { status: 'canceled' },
      });
      await tx.entitlement.updateMany({
        where: {
          organizationId: current.organizationId,
          source: { in: [...BILLING_MANAGED_ENTITLEMENT_SOURCES] },
        },
        data: {
          enabled: false,
          expiresAt: now,
        },
      });
    }

    return confirmedCancellationResult(updated, mode);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

function sameCancellationAttempt(
  current: BillingCancellationAttempt,
  expected: Pick<
    BillingCancellationAttempt,
    | 'id'
    | 'organizationId'
    | 'subscriptionMirrorId'
    | 'billingProvider'
    | 'requestHash'
    | 'requestedByUserId'
    | 'mode'
    | 'requestedAt'
  >
): boolean {
  return current.id === expected.id &&
    current.organizationId === expected.organizationId &&
    current.subscriptionMirrorId === expected.subscriptionMirrorId &&
    current.billingProvider === expected.billingProvider &&
    current.requestHash === expected.requestHash &&
    current.requestedByUserId === expected.requestedByUserId &&
    current.mode === expected.mode &&
    current.requestedAt.getTime() === expected.requestedAt.getTime();
}

async function claimCancellationAttempt(
  mirrorId: string,
  organizationId: string,
  subscription: RazorpaySubscriptionEntity,
  cancellation: {
    requestHash: string;
    requestedByUserId: string;
    mode: CancellationMode;
    requestedAt: Date;
  }
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${organizationId}`}, 0))::text`;

    const current = await tx.subscriptionMirror.findUnique({
      where: { id: mirrorId },
    });
    if (
      !current ||
      current.organizationId !== organizationId ||
      current.billingProvider !== PROVIDER
    ) {
      throw new BillingConflictError('The Razorpay subscription no longer exists');
    }
    validateCancellationSubscription(subscription, current);

    const existingRequest = await tx.billingCancellationAttempt.findUnique({
      where: {
        organizationId_billingProvider_requestHash: {
          organizationId,
          billingProvider: PROVIDER,
          requestHash: cancellation.requestHash,
        },
      },
    });
    if (existingRequest) {
      assertCancellationActor(existingRequest, cancellation.requestedByUserId);
      if (
        existingRequest.subscriptionMirrorId !== current.id ||
        existingRequest.mode !== cancellation.mode
      ) {
        throw new BillingConflictError(
          'This cancellation Idempotency-Key was already used for another request',
          'replace'
        );
      }
      return {
        attempt: existingRequest,
        ownsProviderMutation: false,
      };
    }

    const activeAttempt = await tx.billingCancellationAttempt.findFirst({
      where: {
        subscriptionMirrorId: current.id,
        activeKey: 'active',
      },
    });
    if (activeAttempt) {
      if (activeAttempt.requestHash === cancellation.requestHash) {
        assertCancellationActor(activeAttempt, cancellation.requestedByUserId);
        return {
          attempt: activeAttempt,
          ownsProviderMutation: false,
        };
      }
      throw new BillingConflictError(
        'Another cancellation request is already being reconciled'
      );
    }

    const attempt = await tx.billingCancellationAttempt.create({
      data: {
        organizationId,
        subscriptionMirrorId: current.id,
        billingProvider: PROVIDER,
        requestHash: cancellation.requestHash,
        requestedByUserId: cancellation.requestedByUserId,
        mode: cancellation.mode,
        status: 'submitting',
        activeKey: 'active',
        requestedAt: cancellation.requestedAt,
        nextAttemptAt: new Date(
          cancellation.requestedAt.getTime() + CANCELLATION_RETRY_BASE_MS
        ),
      },
    });
    await tx.subscriptionMirror.update({
      where: { id: current.id },
      data: {
        providerPayload: providerPayload(
          current.providerPayload,
          subscription,
          {
            ...cancellation,
            status: 'submitting',
            requestedAt: cancellation.requestedAt.toISOString(),
          }
        ),
      },
    });
    return {
      attempt,
      ownsProviderMutation: true,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function recordCancellationAttemptState(
  attempt: BillingCancellationAttempt,
  subscription: RazorpaySubscriptionEntity,
  status: Extract<CancellationStatus, 'submitting' | 'failed'>,
  lastError: string
): Promise<boolean> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${attempt.organizationId}`}, 0))::text`;

    const [current, currentAttempt] = await Promise.all([
      tx.subscriptionMirror.findUnique({
        where: { id: attempt.subscriptionMirrorId },
      }),
      tx.billingCancellationAttempt.findUnique({
        where: { id: attempt.id },
      }),
    ]);
    if (
      !current ||
      current.organizationId !== attempt.organizationId ||
      current.billingProvider !== PROVIDER
    ) {
      throw new BillingConflictError('The Razorpay subscription no longer exists');
    }
    validateCancellationSubscription(subscription, current);
    if (
      !currentAttempt ||
      !sameCancellationAttempt(currentAttempt, attempt) ||
      currentAttempt.status !== attempt.status ||
      currentAttempt.leaseToken !== attempt.leaseToken ||
      currentAttempt.status !== 'submitting' ||
      currentAttempt.activeKey !== 'active'
    ) {
      return false;
    }

    const transitioned = await tx.billingCancellationAttempt.updateMany({
      where: {
        id: currentAttempt.id,
        status: currentAttempt.status,
        activeKey: 'active',
        leaseToken: currentAttempt.leaseToken,
      },
      data: {
        status,
        activeKey: status === 'failed' ? null : 'active',
        nextAttemptAt: status === 'failed'
          ? null
          : new Date(now.getTime() + CANCELLATION_RETRY_BASE_MS),
        processingStartedAt: null,
        leaseToken: null,
        lastError,
      },
    });
    if (transitioned.count !== 1) return false;

    await tx.subscriptionMirror.update({
      where: { id: current.id },
      data: {
        providerPayload: providerPayload(
          current.providerPayload,
          subscription,
          {
            requestHash: attempt.requestHash,
            requestedByUserId: attempt.requestedByUserId,
            mode: attempt.mode as CancellationMode,
            status,
            requestedAt: attempt.requestedAt.toISOString(),
            lastError,
          }
        ),
      },
    });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function fetchCancellationState(
  mirror: SubscriptionMirror
): Promise<RazorpaySubscriptionEntity> {
  const subscription = await razorpayRequest<RazorpaySubscriptionEntity>(
    'GET',
    `/v1/subscriptions/${razorpayPathId(mirror.externalSubscriptionId)}`
  );
  validateCancellationSubscription(subscription, mirror);
  return subscription;
}

export async function cancelRazorpaySubscription(
  organizationId: string,
  requestIdempotencyKey: string,
  requestedByUserId: string
) {
  if (!requestedByUserId) {
    throw new Error('An authenticated cancellation actor is required');
  }
  const requestHash = cancellationRequestHash(
    organizationId,
    requestIdempotencyKey
  );
  const matchingAttempt = await prisma.billingCancellationAttempt.findUnique({
    where: {
      organizationId_billingProvider_requestHash: {
        organizationId,
        billingProvider: PROVIDER,
        requestHash,
      },
    },
  });
  const matching = matchingAttempt
    ? await prisma.subscriptionMirror.findUnique({
      where: { id: matchingAttempt.subscriptionMirrorId },
    })
    : null;
  if (matchingAttempt) {
    assertCancellationActor(matchingAttempt, requestedByUserId);
    if (
      matchingAttempt.organizationId !== organizationId ||
      matchingAttempt.billingProvider !== PROVIDER ||
      !['immediate', 'period_end'].includes(matchingAttempt.mode) ||
      !matching
    ) {
      throw new BillingConflictError(
        'The cancellation replay record requires operator reconciliation'
      );
    }
  }
  if (matching && matchingAttempt?.status === 'confirmed') {
    const matchingMode = matchingAttempt.mode as CancellationMode;
    if (
      matchingMode === 'period_end' &&
      matching.activeKey === 'current' &&
      matching.currentPeriodEnd &&
      matching.currentPeriodEnd <= new Date()
    ) {
      const canonical = await fetchCancellationState(matching);
      if (canonical.status === 'cancelled') {
        return applyConfirmedCancellation(
          matchingAttempt,
          canonical,
        );
      }
      if (['completed', 'expired'].includes(canonical.status)) {
        const checkoutIntentId = notes(canonical.notes).checkoutIntentId;
        if (checkoutIntentId) {
          await projectVerifiedRazorpaySubscription(canonical, checkoutIntentId);
        }
      }
    }
    return confirmedCancellationResult(matching, matchingMode);
  }
  if (matchingAttempt?.status === 'failed') {
    throw new BillingConflictError(
      'This cancellation request was already rejected; retry with a new Idempotency-Key',
      'replace'
    );
  }
  if (
    matching &&
    matchingAttempt &&
    ['submitting', 'processing'].includes(matchingAttempt.status)
  ) {
    const matchingMode = matchingAttempt.mode as CancellationMode;
    const canonical = await fetchCancellationState(matching);
    if (await cancellationWasApplied(canonical, matchingMode)) {
      return applyConfirmedCancellation(
        matchingAttempt,
        canonical,
      );
    }
    if (matching.activeKey !== 'current') {
      throw new BillingConflictError(
        'The cancellation request requires operator reconciliation'
      );
    }
    if (
      matchingAttempt.requestedAt.getTime() <=
        Date.now() - CANCELLATION_RECONCILIATION_TIMEOUT_MS
    ) {
      await prisma.billingCancellationAttempt.updateMany({
        where: {
          id: matchingAttempt.id,
          status: 'submitting',
          activeKey: 'active',
        },
        data: {
          nextAttemptAt: new Date(Date.now() + CANCELLATION_REVIEW_RETRY_MS),
          lastError:
            'Provider cancellation state remains ambiguous; operator review is required',
        },
      });
      throw new BillingConflictError(
        'The cancellation request remains ambiguous and requires reconciliation; retry with the same Idempotency-Key',
        'reuse'
      );
    }
    throw new BillingConflictError(
      'The cancellation request is still being reconciled; retry with the same Idempotency-Key',
      'reuse'
    );
  }

  const mirror = await prisma.subscriptionMirror.findFirst({
    where: {
      organizationId,
      billingProvider: PROVIDER,
      activeKey: 'current',
    },
  });
  if (!mirror) {
    throw new BillingConflictError(
      'No current Razorpay subscription exists for this organization'
    );
  }
  if (mirror.cancelAtPeriodEnd) {
    const priorAttempt = await prisma.billingCancellationAttempt.findFirst({
      where: {
        subscriptionMirrorId: mirror.id,
        billingProvider: PROVIDER,
        status: 'confirmed',
      },
      orderBy: { confirmedAt: 'desc' },
    });
    if (!priorAttempt || priorAttempt.mode !== 'period_end') {
      throw new BillingConflictError(
        'The scheduled cancellation is missing its durable request claim; operator review is required'
      );
    }
    return confirmedCancellationResult(mirror, 'period_end');
  }
  if (['canceled', 'completed', 'expired'].includes(mirror.status)) {
    throw new BillingConflictError('This subscription is already terminal');
  }

  const existingAttempt = await prisma.billingCancellationAttempt.findFirst({
    where: {
      subscriptionMirrorId: mirror.id,
      activeKey: 'active',
    },
  });
  if (existingAttempt) {
    throw new BillingConflictError(
      'Another cancellation request is already being reconciled'
    );
  }
  let canonical = await fetchCancellationState(mirror);
  if (canonical.has_scheduled_changes) {
    throw new BillingConflictError(
      'Razorpay already has an unrelated scheduled subscription change; operator review is required'
    );
  }
  if (canonical.status === 'cancelled') {
    const checkoutIntentId = notes(canonical.notes).checkoutIntentId;
    if (checkoutIntentId) {
      await projectVerifiedRazorpaySubscription(canonical, checkoutIntentId);
    }
    throw new BillingConflictError('This subscription is already cancelled');
  }
  if (['completed', 'expired'].includes(canonical.status)) {
    const checkoutIntentId = notes(canonical.notes).checkoutIntentId;
    if (checkoutIntentId) {
      await projectVerifiedRazorpaySubscription(canonical, checkoutIntentId);
    }
    throw new BillingConflictError(
      `This subscription is already ${canonical.status}`
    );
  }
  const mode = cancellationModeFor(canonical);
  const requestedAt = new Date();

  const claimed = await claimCancellationAttempt(
    mirror.id,
    organizationId,
    canonical,
    {
      requestHash,
      requestedByUserId,
      mode,
      requestedAt,
    }
  );
  if (!claimed.ownsProviderMutation) {
    throw new BillingConflictError(
      'The cancellation request is already being reconciled; retry with the same Idempotency-Key',
      'reuse'
    );
  }

  try {
    const cancelled = await razorpayRequest<RazorpaySubscriptionEntity>(
      'POST',
      `/v1/subscriptions/${razorpayPathId(mirror.externalSubscriptionId)}/cancel`,
      { body: { cancel_at_cycle_end: mode === 'period_end' } }
    );
    validateCancellationSubscription(cancelled, mirror);
    if (!(await cancellationWasApplied(cancelled, mode))) {
      throw new Error(
        'Razorpay did not confirm the requested cancellation state'
      );
    }
    return await applyConfirmedCancellation(
      claimed.attempt,
      cancelled
    );
  } catch (error) {
    // A timed-out POST can still have reached Razorpay. Always reconcile the
    // canonical object before deciding whether the request failed.
    try {
      canonical = await fetchCancellationState(mirror);
      if (await cancellationWasApplied(canonical, mode)) {
        return await applyConfirmedCancellation(
          claimed.attempt,
          canonical
        );
      }
    } catch {
      // Preserve the original provider error and the submitting claim. A retry
      // with the same key will reconcile it without issuing a concurrent POST.
    }

    const definitiveRejection = error instanceof RazorpayApiError &&
      !error.retryable &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
    await recordCancellationAttemptState(
      claimed.attempt,
      canonical,
      definitiveRejection ? 'failed' : 'submitting',
      (
        error instanceof Error ? error.message : 'Subscription cancellation failed'
      ).slice(0, 500)
    );
    throw error;
  }
}

function dueCancellationAttemptWhere(
  now: Date
): Prisma.BillingCancellationAttemptWhereInput {
  return {
    billingProvider: PROVIDER,
    activeKey: 'active',
    OR: [
      {
        status: 'submitting',
        OR: [
          { nextAttemptAt: null },
          { nextAttemptAt: { lte: now } },
        ],
      },
      {
        status: 'processing',
        processingStartedAt: {
          lte: new Date(now.getTime() - CANCELLATION_PROCESSING_STALE_MS),
        },
      },
    ],
  };
}

async function claimDueCancellationAttempt(
  now: Date
): Promise<BillingCancellationAttempt | null> {
  const candidate = await prisma.billingCancellationAttempt.findFirst({
    where: dueCancellationAttemptWhere(now),
    orderBy: [
      { nextAttemptAt: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  });
  if (!candidate) return null;

  const leaseToken = crypto.randomUUID();
  const claimed = await prisma.billingCancellationAttempt.updateMany({
    where: {
      id: candidate.id,
      ...dueCancellationAttemptWhere(now),
    },
    data: {
      status: 'processing',
      processingStartedAt: now,
      leaseToken,
      nextAttemptAt: null,
      attempts: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;

  return prisma.billingCancellationAttempt.findFirst({
    where: {
      id: candidate.id,
      status: 'processing',
      activeKey: 'active',
      leaseToken,
    },
  });
}

function cancellationRetryDelayMs(
  attempt: BillingCancellationAttempt,
  now: Date,
  operatorReview: boolean
): number {
  if (
    operatorReview &&
    attempt.requestedAt.getTime() <=
      now.getTime() - CANCELLATION_RECONCILIATION_TIMEOUT_MS
  ) {
    return CANCELLATION_REVIEW_RETRY_MS;
  }
  return Math.min(
    CANCELLATION_RETRY_MAX_MS,
    CANCELLATION_RETRY_BASE_MS *
      2 ** Math.min(Math.max(attempt.attempts - 1, 0), 10)
  );
}

async function releaseCancellationLease(
  attempt: BillingCancellationAttempt,
  message: string,
  now: Date,
  operatorReview = false
): Promise<boolean> {
  if (!attempt.leaseToken) return false;
  const released = await prisma.billingCancellationAttempt.updateMany({
    where: {
      id: attempt.id,
      status: 'processing',
      activeKey: 'active',
      leaseToken: attempt.leaseToken,
    },
    data: {
      status: 'submitting',
      processingStartedAt: null,
      leaseToken: null,
      nextAttemptAt: new Date(
        now.getTime() +
          cancellationRetryDelayMs(attempt, now, operatorReview)
      ),
      lastError: message.slice(0, 500),
    },
  });
  return released.count === 1;
}

/**
 * Reconciles cancellation mutations whose provider response was ambiguous.
 * Claims are indexed and leased so concurrent workers cannot overwrite a
 * newer reconciliation attempt. An absent provider transition remains
 * ambiguous: it is rescheduled for review and the same idempotency key stays
 * reusable instead of risking a duplicate cancellation POST.
 */
export async function reconcilePendingRazorpayCancellations(
  limit = 100,
  now = new Date()
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(
      'Razorpay pending cancellation batch limit must be between 1 and 500'
    );
  }

  let examined = 0;
  let confirmed = 0;
  let pending = 0;
  const failures: unknown[] = [];

  while (examined < limit) {
    const attempt = await claimDueCancellationAttempt(now);
    if (!attempt) break;
    examined += 1;

    try {
      const mirror = await prisma.subscriptionMirror.findUnique({
        where: { id: attempt.subscriptionMirrorId },
      });
      if (
        !mirror ||
        mirror.organizationId !== attempt.organizationId ||
        mirror.billingProvider !== PROVIDER ||
        !['immediate', 'period_end'].includes(attempt.mode)
      ) {
        throw new Error(
          'Pending Razorpay cancellation has an invalid durable request claim'
        );
      }

      const canonical = await fetchCancellationState(mirror);
      if (
        await cancellationWasApplied(
          canonical,
          attempt.mode as CancellationMode
        )
      ) {
        await applyConfirmedCancellation(attempt, canonical);
        confirmed += 1;
        continue;
      }

      await releaseCancellationLease(
        attempt,
        attempt.requestedAt.getTime() <=
          now.getTime() - CANCELLATION_RECONCILIATION_TIMEOUT_MS
          ? 'Provider cancellation state remains ambiguous; operator review is required'
          : 'Provider cancellation state has not appeared yet',
        now,
        true
      );
      pending += 1;
    } catch (error) {
      await releaseCancellationLease(
        attempt,
        error instanceof Error
          ? error.message
          : 'Razorpay cancellation reconciliation failed',
        now
      ).catch(() => false);
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const error = new Error(
      `Razorpay pending cancellation reconciliation failed for ${failures.length} of ${examined} attempts`
    ) as Error & { cause?: unknown };
    error.name = 'RazorpayPendingCancellationReconciliationError';
    error.cause = failures[0];
    throw error;
  }

  return {
    examined,
    confirmed,
    failed: 0,
    pending,
  };
}
