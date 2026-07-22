import { z } from 'zod';
import { getWebOrigin } from '../auth/config';
import {
  USAGE_METRICS,
  USAGE_METRIC_VALUES,
  VOICE_USAGE_METRIC_VALUES,
  type UsageMetric,
} from './metrics';

const stripeId = (prefix: string) =>
  z.string().trim().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const metricName = z.enum(USAGE_METRIC_VALUES);
const meterEventName = z.string().trim().regex(/^[A-Za-z0-9_\-.]{1,100}$/);

const entitlementValue = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().trim().max(500),
]);

const planSchema = z.object({
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  basePriceId: stripeId('price'),
  /** Optional fixed recurring line items, such as a support add-on. */
  licensedPrices: z.array(z.object({
    priceId: stripeId('price'),
    quantity: z.number().int().positive().max(10_000).default(1),
  }).strict()).max(10).default([]),
  /** Metric -> metered recurring Stripe Price. Quantity is omitted at Checkout. */
  meteredPriceIds: z.record(metricName, stripeId('price')).default({}),
  /** Metric -> Stripe Meter event_name. Only configured metrics can be exported. */
  meterEventNames: z.record(metricName, meterEventName).default({}),
  entitlements: z.record(z.string().trim().min(1).max(100), entitlementValue).default({}),
  trialDays: z.number().int().min(0).max(365).default(0),
}).strict().superRefine((plan, context) => {
  const priceIds = [
    plan.basePriceId,
    ...plan.licensedPrices.map((item) => item.priceId),
    ...Object.values(plan.meteredPriceIds),
  ];
  if (priceIds.length > 20) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['meteredPriceIds'],
      message: 'A subscription plan cannot contain more than 20 recurring line items',
    });
  }
  if (new Set(priceIds).size !== priceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe price IDs must be unique within a plan',
    });
  }
  const eventNames = Object.values(plan.meterEventNames);
  if (new Set(eventNames).size !== eventNames.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['meterEventNames'],
      message: 'Stripe meter event names must be unique within a plan',
    });
  }
  if (Object.keys(plan.entitlements).length > 100) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entitlements'],
      message: 'A plan cannot define more than 100 entitlements',
    });
  }
  for (const metric of Object.keys(plan.meteredPriceIds) as UsageMetric[]) {
    if (!plan.meterEventNames[metric]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meterEventNames', metric],
        message: `A meter event name is required for metered metric ${metric}`,
      });
    }
  }
  for (const metric of Object.keys(plan.meterEventNames) as UsageMetric[]) {
    if (!plan.meteredPriceIds[metric]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meteredPriceIds', metric],
        message: `A metered price is required for metric ${metric}`,
      });
    }
  }
  const requiredMetrics = [
    ...(plan.entitlements['communications.voice'] === true ? VOICE_USAGE_METRIC_VALUES : []),
    ...(plan.entitlements['communications.sms'] === true ? [USAGE_METRICS.SMS_SEGMENTS] : []),
  ];
  for (const metric of requiredMetrics) {
    if (!plan.meteredPriceIds[metric] || !plan.meterEventNames[metric]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meteredPriceIds', metric],
        message: `Enabled communication features require metered usage metric ${metric}`,
      });
    }
  }
});

const planMapSchema = z.record(
  z.string().trim().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  planSchema
).superRefine((plans, context) => {
  const count = Object.keys(plans).length;
  if (count === 0 || count > 50) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Billing configuration must define between 1 and 50 plans',
    });
  }
});

export type StripePlan = z.infer<typeof planSchema>;
export type StripePlanMap = z.infer<typeof planMapSchema>;

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function configuredUrl(name: string, fallbackPath: string): string {
  const fallbackOrigin = getWebOrigin().split(',')[0]?.trim() || 'http://localhost:3000';
  const raw = process.env[name] ?? new URL(fallbackPath, fallbackOrigin).toString();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return parsed.toString();
}

export function getStripePlans(): StripePlanMap {
  const raw = process.env.STRIPE_PLAN_CONFIG_JSON;
  if (!raw) throw new Error('STRIPE_PLAN_CONFIG_JSON is required for billing');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('STRIPE_PLAN_CONFIG_JSON must contain valid JSON');
  }

  const result = planMapSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid STRIPE_PLAN_CONFIG_JSON: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

export function requireStripePlan(planKey: string): StripePlan {
  const plan = getStripePlans()[planKey];
  if (!plan) throw new UnknownBillingPlanError('Unknown or unavailable billing plan');
  return plan;
}

export function planKeyForPriceIds(priceIds: string[]): string | null {
  const supplied = new Set(priceIds);
  const matches = Object.entries(getStripePlans()).filter(([, plan]) => {
    const configured = new Set([
      plan.basePriceId,
      ...plan.licensedPrices.map((item) => item.priceId),
      ...Object.values(plan.meteredPriceIds),
    ]);
    return configured.size === supplied.size && [...configured].every((priceId) => supplied.has(priceId));
  });
  return matches.length === 1 ? matches[0][0] : null;
}

export class BillingConfigurationError extends Error {
  readonly statusCode = 503;
}

export class UnknownBillingPlanError extends Error {
  readonly statusCode = 400;
}

export function getStripeRuntimeConfig() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || !/^sk_(?:test|live)_[A-Za-z0-9]+$/.test(secretKey)) {
    throw new BillingConfigurationError('Stripe is not configured');
  }

  const apiBaseUrl = process.env.STRIPE_API_BASE_URL ?? 'https://api.stripe.com';
  const parsedApiBase = new URL(apiBaseUrl);
  if (process.env.NODE_ENV === 'production' && parsedApiBase.origin !== 'https://api.stripe.com') {
    throw new BillingConfigurationError('STRIPE_API_BASE_URL must use Stripe in production');
  }

  return {
    secretKey,
    apiVersion: process.env.STRIPE_API_VERSION || undefined,
    apiBaseUrl: parsedApiBase.toString().replace(/\/$/, ''),
    timeoutMs: integerEnv('STRIPE_API_TIMEOUT_MS', 10_000, 1_000, 30_000),
    maxRetries: integerEnv('STRIPE_API_MAX_RETRIES', 2, 0, 5),
    // Stripe accepts an explicit expiry 30 minutes to 24 hours after it
    // receives the request. Keep margin for application/network latency.
    checkoutTtlMinutes: integerEnv('STRIPE_CHECKOUT_TTL_MINUTES', 60, 35, 1_435),
    webhookToleranceSeconds: integerEnv('STRIPE_WEBHOOK_TOLERANCE_SECONDS', 300, 30, 900),
    gracePeriodDays: integerEnv('BILLING_GRACE_PERIOD_DAYS', 7, 0, 60),
    automaticTax: booleanEnv('STRIPE_AUTOMATIC_TAX', false),
    allowPromotionCodes: booleanEnv('STRIPE_ALLOW_PROMOTION_CODES', false),
    expectedLivemode: process.env.STRIPE_EXPECT_LIVEMODE === undefined
      ? secretKey.startsWith('sk_live_')
      : booleanEnv('STRIPE_EXPECT_LIVEMODE', false),
    checkoutSuccessUrl: configuredUrl('STRIPE_CHECKOUT_SUCCESS_URL', '/settings/billing?checkout=success'),
    checkoutCancelUrl: configuredUrl('STRIPE_CHECKOUT_CANCEL_URL', '/settings/billing?checkout=cancelled'),
    portalReturnUrl: configuredUrl('STRIPE_PORTAL_RETURN_URL', '/settings/billing'),
  };
}

export function getStripeWebhookSecrets(): string[] {
  const values = [
    process.env.STRIPE_WEBHOOK_SECRET,
    ...(process.env.STRIPE_WEBHOOK_SECRETS?.split(',') ?? []),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const unique = [...new Set(values)];
  if (unique.length === 0 || unique.some((value) => !value.startsWith('whsec_'))) {
    throw new BillingConfigurationError('Stripe webhook signing secret is not configured');
  }
  return unique;
}
