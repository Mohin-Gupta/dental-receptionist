import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../auth/secretBox';
import { prisma } from '../lib/prisma';
import { getStripeRuntimeConfig, requireStripePlan } from './config';
import { getConfiguredPriceVersions } from './priceCatalog';
import { StripeApiError, stripeRequest } from './stripeClient';

interface StripeCustomer {
  id: string;
  object: 'customer';
}

interface StripeHostedSession {
  id: string;
  url: string | null;
  expires_at?: number;
}

interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  type: string;
  billing_scheme: string;
  tiers_mode: string | null;
  transform_quantity: { divide_by: number; round: string } | null;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  recurring: null | {
    interval: string;
    interval_count: number;
    usage_type: string;
    meter: string | null;
  };
}

interface StripeMeter {
  id: string;
  object: 'billing.meter';
  event_name: string;
  status: string;
  default_aggregation: { formula: string };
  customer_mapping: { type: string; event_payload_key: string };
  value_settings: { event_payload_key: string };
}

const validatedPlanPrices = new Map<string, number>();

export class BillingConflictError extends Error {
  readonly statusCode = 409;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function safeIdempotencyPart(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 40);
}

async function validateStripePlanPrices(
  planKey: string,
  plan: ReturnType<typeof requireStripePlan>
): Promise<void> {
  const fixedPriceIds = [plan.basePriceId, ...plan.licensedPrices.map(item => item.priceId)];
  const meteredPrices = Object.entries(plan.meteredPriceIds);
  const meteredPriceIds = meteredPrices.map(([, priceId]) => priceId);
  const allPriceIds = [...fixedPriceIds, ...meteredPriceIds];
  const now = new Date();
  const localRateByMetric = new Map<string, ReturnType<typeof getConfiguredPriceVersions>[number]>();
  const rateCandidates = getConfiguredPriceVersions()
    .filter(rate =>
      rate.planKey === planKey &&
      rate.currency === plan.currency &&
      rate.effectiveFrom <= now &&
      (!rate.effectiveTo || rate.effectiveTo > now)
    )
    .sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime());
  for (const rate of rateCandidates) {
    if (!localRateByMetric.has(rate.metric)) localRateByMetric.set(rate.metric, rate);
  }
  const localRates = [...localRateByMetric.values()];
  const validationKey = [
    planKey,
    plan.currency,
    ...allPriceIds,
    ...localRates.map(rate => (
      `${rate.metric}:${rate.version}:${rate.unitAmountMinor}:${rate.unitQuantity.toFixed()}`
    )).sort(),
  ].join(':');
  const cachedUntil = validatedPlanPrices.get(validationKey) ?? 0;
  if (cachedUntil > Date.now()) return;

  const prices = await Promise.all(allPriceIds.map(priceId =>
    stripeRequest<StripePrice>('GET', `/v1/prices/${priceId}`)
  ));
  const recurringIntervals = new Set<string>();
  for (const [index, price] of prices.entries()) {
    const expectedId = allPriceIds[index];
    if (price.id !== expectedId || !price.active || price.type !== 'recurring' || !price.recurring) {
      throw new BillingConflictError(`Stripe plan ${planKey} contains an inactive or non-recurring Price`);
    }
    if (price.currency.toUpperCase() !== plan.currency) {
      throw new BillingConflictError(
        `Stripe plan ${planKey} Price currency does not match configured ${plan.currency}`
      );
    }
    const intervalCount = Number(price.recurring.interval_count ?? 1);
    recurringIntervals.add(`${price.recurring.interval}:${intervalCount}`);
    const shouldBeMetered = index >= fixedPriceIds.length;
    if (shouldBeMetered !== (price.recurring.usage_type === 'metered')) {
      throw new BillingConflictError(
        `Stripe plan ${planKey} has a Price with the wrong recurring usage type`
      );
    }
    if (shouldBeMetered) {
      const metric = meteredPrices[index - fixedPriceIds.length]?.[0];
      const localRate = localRates.find(rate => rate.metric === metric);
      if (!metric || !localRate) {
        throw new BillingConflictError(`Stripe plan ${planKey} has no current local rate for a metered Price`);
      }
      if (
        price.billing_scheme !== 'per_unit' ||
        price.tiers_mode !== null ||
        price.transform_quantity !== null ||
        !price.recurring.meter
      ) {
        throw new BillingConflictError(
          `Stripe plan ${planKey} metered Prices must use untransformed per-unit meter pricing`
        );
      }
      const unitAmount = price.unit_amount_decimal ??
        (price.unit_amount === null ? null : String(price.unit_amount));
      if (!unitAmount || !/^\d+(?:\.\d{1,12})?$/.test(unitAmount)) {
        throw new BillingConflictError(`Stripe plan ${planKey} has an invalid metered unit amount`);
      }
      const localUnitAmount = new Prisma.Decimal(localRate.unitAmountMinor.toString())
        .div(localRate.unitQuantity);
      if (!new Prisma.Decimal(unitAmount).equals(localUnitAmount)) {
        throw new BillingConflictError(
          `Stripe plan ${planKey} metered Price does not match the immutable local rate for ${metric}`
        );
      }
    }
  }
  if (recurringIntervals.size !== 1) {
    throw new BillingConflictError(`Stripe plan ${planKey} mixes recurring billing intervals`);
  }
  const meters = await Promise.all(meteredPrices.map(async ([metric], index) => {
    const meterId = prices[fixedPriceIds.length + index]?.recurring?.meter;
    if (!meterId) throw new BillingConflictError(`Stripe plan ${planKey} is missing a meter for ${metric}`);
    return {
      metric,
      meter: await stripeRequest<StripeMeter>('GET', `/v1/billing/meters/${meterId}`),
    };
  }));
  for (const { metric, meter } of meters) {
    if (
      meter.object !== 'billing.meter' ||
      meter.status !== 'active' ||
      meter.event_name !== plan.meterEventNames[metric as keyof typeof plan.meterEventNames] ||
      meter.default_aggregation?.formula !== 'sum' ||
      meter.customer_mapping?.type !== 'by_id' ||
      meter.customer_mapping?.event_payload_key !== 'stripe_customer_id' ||
      meter.value_settings?.event_payload_key !== 'value'
    ) {
      throw new BillingConflictError(
        `Stripe plan ${planKey} meter configuration does not match ${metric}`
      );
    }
  }
  validatedPlanPrices.set(validationKey, Date.now() + 10 * 60 * 1000);
}

const CURRENT_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
];

function checkoutRequestHash(organizationId: string, requestIdempotencyKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`stripe-checkout\0${organizationId}\0${requestIdempotencyKey}`)
    .digest('hex');
}

function checkoutUrlPurpose(checkoutIntentId: string): string {
  return `billing-checkout:${checkoutIntentId}:url`;
}

function hostedSessionFromIntent(intent: {
  id: string;
  externalSessionId: string | null;
  sessionUrlCiphertext: string | null;
}) {
  if (!intent.externalSessionId || !intent.sessionUrlCiphertext) {
    throw new BillingConflictError('The existing Checkout session is not ready; retry shortly');
  }
  return {
    id: intent.externalSessionId,
    url: decryptSecret(intent.sessionUrlCiphertext, checkoutUrlPurpose(intent.id)),
  };
}

export async function ensureStripeBillingAccount(organizationId: string, currency: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      email: true,
      billingAccount: true,
    },
  });
  if (!organization) throw new Error('Organization not found');

  if (organization.billingAccount) {
    if (organization.billingAccount.billingProvider !== 'stripe') {
      throw new BillingConflictError('This organization uses a different billing provider');
    }
    if (organization.billingAccount.currency !== currency) {
      throw new BillingConflictError(
        'The organization billing currency does not match the requested plan'
      );
    }
    return organization.billingAccount;
  }

  const form: Array<readonly [string, string]> = [
    ['name', organization.name],
    ['metadata[organizationId]', organization.id],
  ];
  if (organization.email) form.push(['email', organization.email]);

  const customer = await stripeRequest<StripeCustomer>('POST', '/v1/customers', {
    form,
    idempotencyKey: `customer:${safeIdempotencyPart(organization.id)}`,
  });
  if (!/^cus_[A-Za-z0-9]+$/.test(customer.id)) {
    throw new Error('Stripe returned an invalid customer identifier');
  }

  try {
    return await prisma.billingAccount.create({
      data: {
        organizationId: organization.id,
        billingProvider: 'stripe',
        externalCustomerId: customer.id,
        status: 'pending',
        billingEmail: organization.email,
        currency,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const account = await prisma.billingAccount.findUniqueOrThrow({
      where: { organizationId: organization.id },
    });
    if (account.billingProvider !== 'stripe' || account.externalCustomerId !== customer.id) {
      throw new BillingConflictError('Billing account provisioning conflict');
    }
    return account;
  }
}

export async function createStripeCheckoutSession(input: {
  organizationId: string;
  planKey: string;
  requestIdempotencyKey: string;
}) {
  const plan = requireStripePlan(input.planKey);
  const config = getStripeRuntimeConfig();
  await validateStripePlanPrices(input.planKey, plan);
  const account = await ensureStripeBillingAccount(input.organizationId, plan.currency);
  const requestKeyHash = checkoutRequestHash(
    input.organizationId,
    input.requestIdempotencyKey
  );
  const requestedExpiresAt = new Date(Date.now() + config.checkoutTtlMinutes * 60_000);

  const intent = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${input.organizationId}`}, 0))`;

    const now = new Date();
    await tx.billingCheckoutSession.updateMany({
      where: {
        organizationId: input.organizationId,
        billingProvider: 'stripe',
        activeKey: 'active',
        expiresAt: { lte: now },
      },
      data: {
        status: 'expired',
        activeKey: null,
        sessionUrlCiphertext: null,
      },
    });

    const existingSubscription = await tx.subscriptionMirror.findFirst({
      where: {
        organizationId: input.organizationId,
        billingProvider: 'stripe',
        status: { in: CURRENT_SUBSCRIPTION_STATUSES },
      },
      select: { id: true },
    });
    if (existingSubscription) {
      throw new BillingConflictError('A subscription already exists; use the billing portal');
    }

    const activeIntent = await tx.billingCheckoutSession.findFirst({
      where: {
        organizationId: input.organizationId,
        billingProvider: 'stripe',
        activeKey: 'active',
      },
    });
    if (activeIntent) {
      if (activeIntent.requestKeyHash !== requestKeyHash) {
        throw new BillingConflictError(
          'Another Checkout session is already open for this organization'
        );
      }
      if (activeIntent.planKey !== input.planKey) {
        throw new BillingConflictError('This idempotency key was already used for another plan');
      }
      return activeIntent;
    }

    const priorRequest = await tx.billingCheckoutSession.findUnique({
      where: {
        organizationId_billingProvider_requestKeyHash: {
          organizationId: input.organizationId,
          billingProvider: 'stripe',
          requestKeyHash,
        },
      },
    });
    if (priorRequest) {
      if (priorRequest.planKey !== input.planKey) {
        throw new BillingConflictError('This idempotency key was already used for another plan');
      }
      throw new BillingConflictError(
        'This Checkout request is no longer reusable; start Checkout again'
      );
    }

    return tx.billingCheckoutSession.create({
      data: {
        organizationId: input.organizationId,
        billingAccountId: account.id,
        billingProvider: 'stripe',
        requestKeyHash,
        planKey: input.planKey,
        status: 'creating',
        activeKey: 'active',
        expiresAt: requestedExpiresAt,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (intent.status === 'open') return hostedSessionFromIntent(intent);
  if (intent.status !== 'creating') {
    throw new BillingConflictError('This Checkout request is no longer active');
  }

  const form: Array<readonly [string, string | number | boolean]> = [
    ['mode', 'subscription'],
    ['customer', account.externalCustomerId],
    ['client_reference_id', input.organizationId],
    ['success_url', config.checkoutSuccessUrl],
    ['cancel_url', config.checkoutCancelUrl],
    ['metadata[organizationId]', input.organizationId],
    ['metadata[planKey]', input.planKey],
    ['metadata[checkoutIntentId]', intent.id],
    ['subscription_data[metadata][organizationId]', input.organizationId],
    ['subscription_data[metadata][planKey]', input.planKey],
    ['subscription_data[metadata][checkoutIntentId]', intent.id],
    ['billing_address_collection', 'required'],
    ['tax_id_collection[enabled]', true],
    ['customer_update[address]', 'auto'],
    ['customer_update[name]', 'auto'],
    ['automatic_tax[enabled]', config.automaticTax],
    ['allow_promotion_codes', config.allowPromotionCodes],
    ['expires_at', Math.floor(intent.expiresAt.getTime() / 1000)],
  ];

  let lineItem = 0;
  form.push([`line_items[${lineItem}][price]`, plan.basePriceId]);
  form.push([`line_items[${lineItem}][quantity]`, 1]);
  lineItem += 1;

  for (const licensed of plan.licensedPrices) {
    form.push([`line_items[${lineItem}][price]`, licensed.priceId]);
    form.push([`line_items[${lineItem}][quantity]`, licensed.quantity]);
    lineItem += 1;
  }
  for (const priceId of Object.values(plan.meteredPriceIds)) {
    form.push([`line_items[${lineItem}][price]`, priceId]);
    lineItem += 1;
  }
  if (plan.trialDays > 0) {
    form.push(['subscription_data[trial_period_days]', plan.trialDays]);
    form.push(['subscription_data[trial_settings][end_behavior][missing_payment_method]', 'cancel']);
  }

  try {
    const session = await stripeRequest<StripeHostedSession>('POST', '/v1/checkout/sessions', {
      form,
      // The durable intent ID, rather than the caller's key, makes a crash
      // between Stripe and PostgreSQL safely resumable.
      idempotencyKey: `checkout-intent:${safeIdempotencyPart(intent.id)}`,
    });
    if (!session.url || !session.id.startsWith('cs_')) {
      throw new Error('Stripe did not return a Checkout URL');
    }

    const providerExpiresAt = typeof session.expires_at === 'number' &&
      Number.isSafeInteger(session.expires_at)
      ? new Date(session.expires_at * 1000)
      : intent.expiresAt;
    const encryptedUrl = encryptSecret(session.url, checkoutUrlPurpose(intent.id));
    const updated = await prisma.billingCheckoutSession.updateMany({
      where: { id: intent.id, status: 'creating', activeKey: 'active' },
      data: {
        externalSessionId: session.id,
        sessionUrlCiphertext: encryptedUrl,
        expiresAt: providerExpiresAt,
        status: 'open',
        lastError: null,
      },
    });

    if (updated.count === 0) {
      const current = await prisma.billingCheckoutSession.findUniqueOrThrow({
        where: { id: intent.id },
      });
      if (current.externalSessionId && current.externalSessionId !== session.id) {
        throw new BillingConflictError('Checkout provider attribution conflict');
      }
    }
    return { id: session.id, url: session.url };
  } catch (error) {
    // Only a definitive, non-retryable Stripe rejection proves that no hosted
    // session was created. Timeouts, malformed responses, encryption failures,
    // and database failures are ambiguous and must retain the single-flight
    // claim so a retry reuses Stripe's provider idempotency key.
    const definitiveRejection = error instanceof StripeApiError &&
      !error.retryable && error.statusCode >= 400 && error.statusCode < 500;
    await prisma.billingCheckoutSession.updateMany({
      where: { id: intent.id, status: 'creating' },
      data: {
        status: definitiveRejection ? 'failed' : 'creating',
        activeKey: definitiveRejection ? null : 'active',
        lastError: (error instanceof Error ? error.message : 'Checkout creation failed').slice(0, 500),
      },
    });
    throw error;
  }
}

export async function createStripePortalSession(organizationId: string) {
  const account = await prisma.billingAccount.findUnique({ where: { organizationId } });
  if (!account || account.billingProvider !== 'stripe') {
    throw new BillingConflictError('No Stripe billing account exists for this organization');
  }

  const session = await stripeRequest<StripeHostedSession>('POST', '/v1/billing_portal/sessions', {
    form: [
      ['customer', account.externalCustomerId],
      ['return_url', getStripeRuntimeConfig().portalReturnUrl],
    ],
    idempotencyKey: `portal:${safeIdempotencyPart(organizationId)}:${crypto.randomUUID()}`,
  });
  if (!session.url || !session.id.startsWith('bps_')) {
    throw new Error('Stripe did not return a billing portal URL');
  }
  return { id: session.id, url: session.url };
}
