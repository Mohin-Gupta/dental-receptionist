import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  getStripeRuntimeConfig,
  planKeyForPriceIds,
  requireStripePlan,
  UnknownBillingPlanError,
} from './config';
import { StripeApiError, stripePathId, stripeRequest } from './stripeClient';
import type { StripeEvent } from './stripeWebhook';

type JsonObject = Record<string, unknown>;

const CURRENT_SUBSCRIPTION_STATUSES = new Set([
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
]);

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

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return typeof object(value)?.id === 'string' ? object(value)!.id as string : null;
}

function unixDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? new Date(value * 1000)
    : null;
}

function metadata(value: unknown): Record<string, string> {
  const record = object(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function customerId(stripeObject: JsonObject): string | null {
  return stringId(stripeObject.customer);
}

function subscriptionIdFromInvoice(invoice: JsonObject): string | null {
  const legacy = stringId(invoice.subscription);
  if (legacy) return legacy;

  const parent = object(invoice.parent);
  const details = object(parent?.subscription_details);
  const direct = stringId(details?.subscription);
  if (direct) return direct;

  const lines = object(invoice.lines);
  const data = Array.isArray(lines?.data) ? lines!.data : [];
  for (const line of data) {
    const lineParent = object(object(line)?.parent);
    const itemDetails = object(lineParent?.subscription_item_details);
    const nested = stringId(itemDetails?.subscription);
    if (nested) return nested;
  }
  return null;
}

function priceIdsFromSubscription(subscription: JsonObject): string[] {
  const items = object(subscription.items);
  const data = Array.isArray(items?.data) ? items!.data : [];
  return data.flatMap((item) => {
    const priceId = stringId(object(item)?.price);
    return priceId ? [priceId] : [];
  });
}

function priceCurrenciesFromSubscription(subscription: JsonObject): string[] {
  const items = object(subscription.items);
  const data = Array.isArray(items?.data) ? items!.data : [];
  return data.flatMap((item) => {
    const price = object(object(item)?.price);
    return typeof price?.currency === 'string' ? [price.currency.toUpperCase()] : [];
  });
}

function subscriptionPeriod(subscription: JsonObject): { start: Date | null; end: Date | null } {
  const topStart = unixDate(subscription.current_period_start);
  const topEnd = unixDate(subscription.current_period_end);
  if (topStart || topEnd) return { start: topStart, end: topEnd };

  const items = object(subscription.items);
  const data = Array.isArray(items?.data) ? items!.data : [];
  const starts = data
    .map((item) => unixDate(object(item)?.current_period_start))
    .filter((value): value is Date => Boolean(value));
  const ends = data
    .map((item) => unixDate(object(item)?.current_period_end))
    .filter((value): value is Date => Boolean(value));
  return {
    start: starts.length ? new Date(Math.min(...starts.map((value) => value.getTime()))) : null,
    end: ends.length ? new Date(Math.max(...ends.map((value) => value.getTime()))) : null,
  };
}

function subscriptionPlanKey(subscription: JsonObject): string {
  const priceIds = priceIdsFromSubscription(subscription);
  const fromPrices = planKeyForPriceIds(priceIds);
  const fromMetadata = metadata(subscription.metadata).planKey;

  if (fromMetadata) {
    try {
      requireStripePlan(fromMetadata);
    } catch (error) {
      if (error instanceof UnknownBillingPlanError) {
        throw new BillingProjectionError('Subscription references an unavailable plan', false);
      }
      throw error;
    }
    if (fromPrices !== fromMetadata) {
      throw new BillingProjectionError('Subscription metadata does not match configured prices', false);
    }
    return fromMetadata;
  }
  if (!fromPrices) {
    throw new BillingProjectionError('Subscription prices do not map to exactly one configured plan', false);
  }
  return fromPrices;
}

function expectedOrganizationIds(stripeObject: JsonObject): string[] {
  const values = [
    metadata(stripeObject.metadata).organizationId,
    typeof stripeObject.client_reference_id === 'string' ? stripeObject.client_reference_id : undefined,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

async function resolveBillingAccount(stripeObject: JsonObject) {
  const externalCustomerId = customerId(stripeObject);
  if (!externalCustomerId || !/^cus_[A-Za-z0-9]+$/.test(externalCustomerId)) {
    throw new BillingProjectionError('Stripe event has no valid customer attribution', false);
  }

  const account = await prisma.billingAccount.findUnique({
    where: {
      billingProvider_externalCustomerId: {
        billingProvider: 'stripe',
        externalCustomerId,
      },
    },
  });
  if (!account) {
    throw new BillingProjectionError('Stripe customer is not mapped to a billing account', false);
  }

  const claimedOrganizations = expectedOrganizationIds(stripeObject);
  if (claimedOrganizations.some((organizationId) => organizationId !== account.organizationId)) {
    throw new BillingProjectionError('Stripe metadata conflicts with customer ownership', false);
  }
  return account;
}

async function retrieveSubscription(subscriptionId: string): Promise<JsonObject> {
  try {
    return await stripeRequest<JsonObject>(
      'GET',
      `/v1/subscriptions/${stripePathId(subscriptionId)}`,
      { query: [['expand[]', 'items.data.price']] }
    );
  } catch (error) {
    if (error instanceof StripeApiError) {
      throw new BillingProjectionError(
        'Unable to retrieve canonical subscription state',
        error.retryable,
        error.statusCode
      );
    }
    throw error;
  }
}

async function retrieveInvoice(invoiceId: string): Promise<JsonObject> {
  try {
    return await stripeRequest<JsonObject>(
      'GET',
      `/v1/invoices/${stripePathId(invoiceId)}`
    );
  } catch (error) {
    if (error instanceof StripeApiError) {
      throw new BillingProjectionError(
        'Unable to retrieve canonical invoice state',
        error.retryable,
        error.statusCode
      );
    }
    throw error;
  }
}

function accessState(status: string, eventCreated: Date, priorGraceUntil: Date | null) {
  if (status === 'active' || status === 'trialing') {
    return { organizationStatus: 'active', billingStatus: 'active', graceUntil: null };
  }
  if (status === 'past_due') {
    const graceUntil = priorGraceUntil ?? new Date(
      eventCreated.getTime() + getStripeRuntimeConfig().gracePeriodDays * 86_400_000
    );
    const graceActive = graceUntil.getTime() > Date.now();
    return {
      organizationStatus: graceActive ? 'past_due_grace' : 'suspended',
      billingStatus: 'past_due',
      graceUntil,
    };
  }
  if (status === 'canceled') {
    return { organizationStatus: 'canceled', billingStatus: 'canceled', graceUntil: null };
  }
  if (status === 'incomplete') {
    return { organizationStatus: 'pending_payment', billingStatus: 'pending', graceUntil: null };
  }
  return { organizationStatus: 'suspended', billingStatus: status, graceUntil: null };
}

async function materializeEntitlements(
  tx: Prisma.TransactionClient,
  organizationId: string,
  subscriptionMirrorId: string,
  planKey: string,
  accessEnabled: boolean,
  expiresAt: Date | null
) {
  const configured = requireStripePlan(planKey).entitlements;
  const keys = Object.keys(configured);
  await tx.entitlement.deleteMany({
    where: {
      organizationId,
      source: 'stripe-plan',
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
        source: 'stripe-plan',
        expiresAt,
      },
      update: {
        subscriptionMirrorId,
        enabled,
        limit,
        value: value as Prisma.InputJsonValue,
        source: 'stripe-plan',
        effectiveAt: new Date(),
        expiresAt,
      },
    });
  }
}

async function projectSubscription(
  account: Awaited<ReturnType<typeof resolveBillingAccount>>,
  subscription: JsonObject,
  eventCreated: Date
) {
  const externalSubscriptionId = stringId(subscription.id);
  const status = typeof subscription.status === 'string' ? subscription.status : null;
  if (!externalSubscriptionId?.startsWith('sub_') || !status) {
    throw new BillingProjectionError('Invalid canonical subscription object', false);
  }
  const canonicalCustomer = customerId(subscription);
  if (canonicalCustomer !== account.externalCustomerId) {
    throw new BillingProjectionError('Subscription customer conflicts with billing account', false);
  }
  const claimedOrganizations = expectedOrganizationIds(subscription);
  if (claimedOrganizations.some((organizationId) => organizationId !== account.organizationId)) {
    throw new BillingProjectionError('Subscription metadata conflicts with customer ownership', false);
  }

  const planKey = subscriptionPlanKey(subscription);
  const plan = requireStripePlan(planKey);
  const priceIds = priceIdsFromSubscription(subscription);
  const priceCurrencies = priceCurrenciesFromSubscription(subscription);
  if (priceCurrencies.length !== priceIds.length || priceCurrencies.some(value => value !== plan.currency)) {
    throw new BillingProjectionError(
      'Subscription Price currency does not match the configured plan currency',
      false
    );
  }
  if (account.currency !== plan.currency) {
    throw new BillingProjectionError(
      'Subscription currency conflicts with the organization billing account',
      false
    );
  }
  const period = subscriptionPeriod(subscription);
  const existing = await prisma.subscriptionMirror.findUnique({
    where: {
      billingProvider_externalSubscriptionId: {
        billingProvider: 'stripe',
        externalSubscriptionId,
      },
    },
    select: { organizationId: true },
  });
  if (existing && existing.organizationId !== account.organizationId) {
    throw new BillingProjectionError('Subscription is already owned by another organization', false);
  }
  const activeKey = CURRENT_SUBSCRIPTION_STATUSES.has(status) ? 'current' : null;

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${account.organizationId}`}, 0))`;

    const currentMirror = await tx.subscriptionMirror.findUnique({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: 'stripe',
          externalSubscriptionId,
        },
      },
    });
    if (
      currentMirror?.lastProviderEventCreatedAt &&
      currentMirror.lastProviderEventCreatedAt > eventCreated
    ) {
      // Stripe delivery is unordered. A canonical refresh triggered by an
      // older event must never replace state already projected by a newer one.
      return currentMirror;
    }

    if (activeKey) {
      const competing = await tx.subscriptionMirror.findFirst({
        where: {
          organizationId: account.organizationId,
          billingProvider: 'stripe',
          activeKey: 'current',
          externalSubscriptionId: { not: externalSubscriptionId },
        },
        select: { id: true },
      });
      if (competing) {
        throw new BillingProjectionError(
          'A different current subscription already controls this organization',
          false
        );
      }
    }

    const access = accessState(status, eventCreated, currentMirror?.graceUntil ?? null);
    const wasController = currentMirror?.activeKey === 'current';

    const mirror = await tx.subscriptionMirror.upsert({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: 'stripe',
          externalSubscriptionId,
        },
      },
      create: {
        organizationId: account.organizationId,
        billingAccountId: account.id,
        billingProvider: 'stripe',
        externalSubscriptionId,
        planKey,
        status,
        activeKey,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        trialEnd: unixDate(subscription.trial_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        canceledAt: unixDate(subscription.canceled_at),
        graceUntil: access.graceUntil,
        providerPayload: {
          priceIds: priceIdsFromSubscription(subscription),
          latestInvoiceId: stringId(subscription.latest_invoice),
        },
        lastProviderEventCreatedAt: eventCreated,
      },
      update: {
        billingAccountId: account.id,
        planKey,
        status,
        activeKey,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        trialEnd: unixDate(subscription.trial_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        canceledAt: unixDate(subscription.canceled_at),
        graceUntil: access.graceUntil,
        providerPayload: {
          priceIds: priceIdsFromSubscription(subscription),
          latestInvoiceId: stringId(subscription.latest_invoice),
        },
        lastProviderEventCreatedAt: eventCreated,
      },
    });

    const competingController = await tx.subscriptionMirror.findFirst({
      where: {
        organizationId: account.organizationId,
        billingProvider: 'stripe',
        activeKey: 'current',
        id: { not: mirror.id },
      },
      select: { id: true },
    });
    const controlsTenantAccess = activeKey === 'current' || (
      wasController && !competingController
    );

    // Historical/terminal subscriptions remain in the local mirror for audit,
    // but only the controlling subscription can change tenant-wide access.
    if (!controlsTenantAccess) return mirror;

    await tx.billingAccount.update({
      where: { id: account.id },
      data: { status: access.billingStatus },
    });
    await tx.organization.update({
      where: { id: account.organizationId },
      data: { status: access.organizationStatus, planTier: planKey },
    });
    await materializeEntitlements(
      tx,
      account.organizationId,
      mirror.id,
      planKey,
      ['active', 'trialing', 'past_due'].includes(status) && access.organizationStatus !== 'suspended',
      access.graceUntil
    );
    if (activeKey === 'current') {
      await tx.billingCheckoutSession.updateMany({
        where: {
          organizationId: account.organizationId,
          billingProvider: 'stripe',
          activeKey: 'active',
        },
        data: {
          status: 'superseded',
          activeKey: null,
          sessionUrlCiphertext: null,
          lastError: 'A current subscription already controls this organization',
        },
      });
    }
    return mirror;
  });
}

async function resolveCheckoutIntent(
  account: Awaited<ReturnType<typeof resolveBillingAccount>>,
  checkoutSession: JsonObject
) {
  const externalSessionId = stringId(checkoutSession.id);
  if (!externalSessionId?.startsWith('cs_')) {
    throw new BillingProjectionError('Checkout event has an invalid session identifier', false);
  }

  const sessionMetadata = metadata(checkoutSession.metadata);
  const claimedIntentId = sessionMetadata.checkoutIntentId;
  const byClaim = claimedIntentId
    ? await prisma.billingCheckoutSession.findUnique({ where: { id: claimedIntentId } })
    : null;
  const byExternal = await prisma.billingCheckoutSession.findUnique({
    where: {
      billingProvider_externalSessionId: {
        billingProvider: 'stripe',
        externalSessionId,
      },
    },
  });

  if (claimedIntentId && !byClaim) {
    throw new BillingProjectionError('Checkout intent attribution is unknown', false);
  }
  if (byClaim && byExternal && byClaim.id !== byExternal.id) {
    throw new BillingProjectionError('Checkout session maps to conflicting intents', false);
  }

  const intent = byClaim ?? byExternal;
  // Allow a short-lived rollout window for Checkout sessions created before
  // durable intents were deployed. Every new application session carries the ID.
  if (!intent) return null;
  if (
    intent.organizationId !== account.organizationId ||
    intent.billingAccountId !== account.id ||
    intent.billingProvider !== 'stripe'
  ) {
    throw new BillingProjectionError('Checkout intent ownership mismatch', false);
  }
  if (sessionMetadata.planKey && sessionMetadata.planKey !== intent.planKey) {
    throw new BillingProjectionError('Checkout intent plan mismatch', false);
  }
  if (intent.externalSessionId && intent.externalSessionId !== externalSessionId) {
    throw new BillingProjectionError('Checkout intent provider identifier mismatch', false);
  }
  return intent;
}

async function finishCheckoutIntent(
  intent: Awaited<ReturnType<typeof resolveCheckoutIntent>>,
  checkoutSession: JsonObject,
  status: 'completed' | 'expired' | 'failed'
) {
  if (!intent) return;
  const externalSessionId = stringId(checkoutSession.id)!;
  await prisma.billingCheckoutSession.update({
    where: { id: intent.id },
    data: {
      externalSessionId,
      status,
      activeKey: null,
      sessionUrlCiphertext: null,
      completedAt: status === 'completed' ? new Date() : intent.completedAt,
      lastError: status === 'failed' ? 'Stripe reported asynchronous payment failure' : null,
    },
  });
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

const INVOICE_FAILURE_EVENTS = new Set([
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.finalization_failed',
]);

export async function processStripeEvent(event: StripeEvent): Promise<Record<string, unknown>> {
  const stripeObject = event.data.object;
  const eventCreated = new Date(event.created * 1000);

  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const account = await resolveBillingAccount(stripeObject);
    const checkoutIntent = await resolveCheckoutIntent(account, stripeObject);
    const subscriptionId = stringId(stripeObject.subscription);
    if (!subscriptionId?.startsWith('sub_')) {
      throw new BillingProjectionError('Completed Checkout session has no subscription', false);
    }
    const mirror = await projectSubscription(
      account,
      await retrieveSubscription(subscriptionId),
      eventCreated
    );
    await finishCheckoutIntent(checkoutIntent, stripeObject, 'completed');
    return {
      action: 'subscription_projected',
      organizationId: account.organizationId,
      subscriptionMirrorId: mirror.id,
    };
  }

  if (
    event.type === 'checkout.session.expired' ||
    event.type === 'checkout.session.async_payment_failed'
  ) {
    const account = await resolveBillingAccount(stripeObject);
    const checkoutIntent = await resolveCheckoutIntent(account, stripeObject);
    await finishCheckoutIntent(
      checkoutIntent,
      stripeObject,
      event.type === 'checkout.session.expired' ? 'expired' : 'failed'
    );
    return {
      action: 'checkout_closed',
      organizationId: account.organizationId,
      checkoutStatus: event.type === 'checkout.session.expired' ? 'expired' : 'failed',
    };
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const account = await resolveBillingAccount(stripeObject);
    const subscriptionId = stringId(stripeObject.id);
    if (!subscriptionId?.startsWith('sub_')) {
      throw new BillingProjectionError('Subscription event has an invalid object', false);
    }
    const canonical = await retrieveSubscription(subscriptionId);
    const mirror = await projectSubscription(account, canonical, eventCreated);
    return {
      action: 'subscription_projected',
      organizationId: account.organizationId,
      subscriptionMirrorId: mirror.id,
    };
  }

  if (event.type === 'invoice.paid') {
    const account = await resolveBillingAccount(stripeObject);
    const subscriptionId = subscriptionIdFromInvoice(stripeObject);
    if (!subscriptionId) {
      return { action: 'one_off_invoice_ignored', organizationId: account.organizationId };
    }
    const mirror = await projectSubscription(
      account,
      await retrieveSubscription(subscriptionId),
      eventCreated
    );
    return {
      action: 'subscription_projected',
      organizationId: account.organizationId,
      subscriptionMirrorId: mirror.id,
    };
  }

  if (INVOICE_FAILURE_EVENTS.has(event.type)) {
    const account = await resolveBillingAccount(stripeObject);
    const invoiceId = stringId(stripeObject.id);
    if (!invoiceId?.startsWith('in_')) {
      throw new BillingProjectionError('Invoice event has an invalid object', false);
    }
    const invoice = await retrieveInvoice(invoiceId);
    if (customerId(invoice) !== account.externalCustomerId) {
      throw new BillingProjectionError('Invoice customer conflicts with billing account', false);
    }
    const subscriptionId = subscriptionIdFromInvoice(invoice) ?? subscriptionIdFromInvoice(stripeObject);
    if (invoice.paid === true || invoice.status === 'paid' || invoice.status === 'void') {
      if (!subscriptionId) {
        return { action: 'resolved_invoice_failure_ignored', organizationId: account.organizationId };
      }
      const mirror = await projectSubscription(
        account,
        await retrieveSubscription(subscriptionId),
        eventCreated
      );
      return {
        action: 'resolved_invoice_reconciled',
        organizationId: account.organizationId,
        subscriptionMirrorId: mirror.id,
      };
    }
    if (!subscriptionId) {
      // A one-off/non-subscription invoice must never suspend the SaaS plan.
      return { action: 'one_off_invoice_failure_ignored', organizationId: account.organizationId };
    }
    const mirror = await projectSubscription(
      account,
      await retrieveSubscription(subscriptionId),
      eventCreated
    );
    return {
      action: 'subscription_failure_reconciled',
      organizationId: account.organizationId,
      subscriptionMirrorId: mirror.id,
    };
  }

  return { action: 'ignored', eventType: event.type };
}
