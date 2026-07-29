import { z } from 'zod';

const entitlementValue = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().trim().max(500),
]);

const planSchema = z.object({
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  planId: z.string().trim().regex(
    /^plan_[A-Za-z0-9]{14}$/,
    'Razorpay planId must be plan_ followed by exactly 14 letters or digits'
  ),
  /** Expected canonical Razorpay Plan amount, in the currency's minor unit. */
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  period: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().positive().max(10_000).default(1),
  quantity: z.number().int().positive().max(10_000).default(1),
  /**
   * Number of fixed recurring charges. Razorpay validates the provider-specific
   * maximum for the configured period and interval.
   */
  totalCount: z.number().int().positive().max(36_600),
  customerNotify: z.boolean().default(true),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(255).optional(),
  entitlements: z.record(
    z.string().trim().min(1).max(100),
    entitlementValue
  ).default({}),
  /**
   * A trial is represented by a future Razorpay subscription start_at. The
   * checkout still has to be authenticated before trial access can be granted.
   */
  trialDays: z.number().int().min(0).max(365).default(0),
}).strict().superRefine((plan, context) => {
  if (Object.keys(plan.entitlements).length > 100) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entitlements'],
      message: 'A plan cannot define more than 100 entitlements',
    });
  }
  const maximumCyclesByPeriod = {
    daily: 36_500,
    weekly: 5_200,
    monthly: 1_200,
    yearly: 100,
  } as const;
  if (plan.interval * plan.totalCount > maximumCyclesByPeriod[plan.period]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalCount'],
      message: 'Razorpay subscription duration cannot exceed 100 years',
    });
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

  const planIds = Object.values(plans).map(plan => plan.planId);
  if (new Set(planIds).size !== planIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Razorpay plan IDs must be unique across billing plans',
    });
  }
});

export type RazorpayPlan = z.infer<typeof planSchema>;
export type RazorpayPlanMap = z.infer<typeof planMapSchema>;
export type RazorpayKeyMode = 'test' | 'live';

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function keyMode(value: string): RazorpayKeyMode {
  if (value === 'test' || value === 'live') return value;
  throw new BillingConfigurationError('RAZORPAY_EXPECT_KEY_MODE must be test or live');
}

export function getRazorpayPlans(): RazorpayPlanMap {
  const raw = process.env.RAZORPAY_PLAN_CONFIG_JSON;
  if (!raw) throw new Error('RAZORPAY_PLAN_CONFIG_JSON is required for billing');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('RAZORPAY_PLAN_CONFIG_JSON must contain valid JSON');
  }

  const result = planMapSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid RAZORPAY_PLAN_CONFIG_JSON: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

export function requireRazorpayPlan(planKey: string): RazorpayPlan {
  const plan = getRazorpayPlans()[planKey];
  if (!plan) throw new UnknownBillingPlanError('Unknown or unavailable billing plan');
  return plan;
}

export function planKeyForRazorpayPlanId(planId: string): string | null {
  const matches = Object.entries(getRazorpayPlans())
    .filter(([, plan]) => plan.planId === planId);
  return matches.length === 1 ? matches[0][0] : null;
}

export class BillingConfigurationError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigurationError';
  }
}

export class UnknownBillingPlanError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'UnknownBillingPlanError';
  }
}

export interface RazorpayRuntimeConfig {
  keyId: string;
  keySecret: string;
  keyMode: RazorpayKeyMode;
  expectedKeyMode: RazorpayKeyMode;
  apiBaseUrl: string;
  timeoutMs: number;
  maxGetRetries: number;
  subscriptionAuthTtlMinutes: number;
  gracePeriodDays: number;
  checkoutName: string;
  accountId?: string;
}

export function getRazorpayRuntimeConfig(): RazorpayRuntimeConfig {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  const match = keyId?.match(/^rzp_(test|live)_[A-Za-z0-9]+$/);
  if (!keyId || !match || !keySecret || keySecret.length < 16 || keySecret.length > 512) {
    throw new BillingConfigurationError('Razorpay is not configured');
  }

  const detectedKeyMode = match[1] as RazorpayKeyMode;
  const configuredExpectedMode = process.env.RAZORPAY_EXPECT_KEY_MODE?.trim();
  if (process.env.NODE_ENV === 'production' && !configuredExpectedMode) {
    throw new BillingConfigurationError(
      'RAZORPAY_EXPECT_KEY_MODE is required in production'
    );
  }
  const expectedKeyMode = configuredExpectedMode
    ? keyMode(configuredExpectedMode)
    : detectedKeyMode;
  if (detectedKeyMode !== expectedKeyMode) {
    throw new BillingConfigurationError(
      `Razorpay ${detectedKeyMode} key does not match expected ${expectedKeyMode} mode`
    );
  }

  const rawApiBaseUrl = process.env.RAZORPAY_API_BASE_URL?.trim() ||
    'https://api.razorpay.com';
  let parsedApiBase: URL;
  try {
    parsedApiBase = new URL(rawApiBaseUrl);
  } catch {
    throw new BillingConfigurationError('RAZORPAY_API_BASE_URL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsedApiBase.protocol)) {
    throw new BillingConfigurationError('RAZORPAY_API_BASE_URL must use HTTP or HTTPS');
  }
  if (
    parsedApiBase.username ||
    parsedApiBase.password ||
    parsedApiBase.pathname !== '/' ||
    parsedApiBase.search ||
    parsedApiBase.hash
  ) {
    throw new BillingConfigurationError(
      'RAZORPAY_API_BASE_URL must be an origin without credentials, path, query, or fragment'
    );
  }
  if (
    process.env.NODE_ENV === 'production' &&
    parsedApiBase.origin !== 'https://api.razorpay.com'
  ) {
    throw new BillingConfigurationError(
      'RAZORPAY_API_BASE_URL must use the official Razorpay API in production'
    );
  }

  const accountId = process.env.RAZORPAY_ACCOUNT_ID?.trim() || undefined;
  if (accountId && !/^acc_[A-Za-z0-9]+$/.test(accountId)) {
    throw new BillingConfigurationError('RAZORPAY_ACCOUNT_ID is invalid');
  }

  const checkoutName = (process.env.RAZORPAY_CHECKOUT_NAME ||
    process.env.APP_NAME ||
    'Dental Receptionist').trim();
  if (!checkoutName || checkoutName.length > 100) {
    throw new BillingConfigurationError(
      'RAZORPAY_CHECKOUT_NAME must contain between 1 and 100 characters'
    );
  }

  return {
    keyId,
    keySecret,
    keyMode: detectedKeyMode,
    expectedKeyMode,
    apiBaseUrl: parsedApiBase.toString().replace(/\/$/, ''),
    timeoutMs: integerEnv('RAZORPAY_API_TIMEOUT_MS', 10_000, 1_000, 30_000),
    maxGetRetries: integerEnv('RAZORPAY_API_MAX_RETRIES', 2, 0, 5),
    subscriptionAuthTtlMinutes: integerEnv(
      'RAZORPAY_SUBSCRIPTION_AUTH_TTL_MINUTES',
      60,
      5,
      1_440
    ),
    gracePeriodDays: integerEnv('BILLING_GRACE_PERIOD_DAYS', 7, 0, 60),
    checkoutName,
    accountId,
  };
}

export function getRazorpayWebhookSecrets(): string[] {
  const values = [
    process.env.RAZORPAY_WEBHOOK_SECRET,
    ...(process.env.RAZORPAY_WEBHOOK_SECRETS?.split(',') ?? []),
  ]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));

  const unique = [...new Set(values)];
  if (
    unique.length === 0 ||
    unique.some(value => value.length < 32 || value.length > 512)
  ) {
    throw new BillingConfigurationError(
      'Razorpay webhook signing secret is not configured securely'
    );
  }
  return unique;
}
