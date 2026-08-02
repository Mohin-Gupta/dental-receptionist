import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';
import { tenantBudgetInputSchema } from '../src/billing/budgets';
import {
  getRazorpayPlans,
  planKeyForRazorpayPlanId,
} from '../src/billing/config';
import { USAGE_METRICS } from '../src/billing/metrics';
import {
  PriceCatalogConfigurationError,
  parseConfiguredPriceVersions,
} from '../src/billing/priceCatalog';

const originalPlanConfig = process.env.RAZORPAY_PLAN_CONFIG_JSON;

function completePlan() {
  return {
    currency: 'INR',
    planId: 'plan_00000000000001',
    amountMinor: 49900,
    period: 'monthly' as const,
    interval: 1,
    quantity: 1,
    totalCount: 120,
    customerNotify: true,
    entitlements: {
      'appointments.write': true,
      'communications.voice': true,
      'communications.sms': true,
    },
    trialDays: 14,
  };
}

beforeEach(() => {
  process.env.RAZORPAY_PLAN_CONFIG_JSON = JSON.stringify({ starter: completePlan() });
});

afterEach(() => {
  if (originalPlanConfig === undefined) delete process.env.RAZORPAY_PLAN_CONFIG_JSON;
  else process.env.RAZORPAY_PLAN_CONFIG_JSON = originalPlanConfig;
});

test('the billing plan accepts a fixed Razorpay subscription and local entitlements', () => {
  const plan = getRazorpayPlans().starter;
  assert.equal(plan.planId, 'plan_00000000000001');
  assert.equal(plan.amountMinor, 49900);
  assert.equal(plan.period, 'monthly');
  assert.equal(plan.entitlements['communications.voice'], true);
});

test('Stripe metering fields cannot enter the fixed Razorpay plan configuration', () => {
  const plan = completePlan();
  const legacyPlan = {
    ...plan,
    meteredPriceIds: { voice_seconds: 'price_Legacy' },
  };
  process.env.RAZORPAY_PLAN_CONFIG_JSON = JSON.stringify({ starter: legacyPlan });

  assert.throws(() => getRazorpayPlans(), /Invalid RAZORPAY_PLAN_CONFIG_JSON/);
  assert.equal(tenantBudgetInputSchema.safeParse({
    metric: 'compute_milliseconds',
    period: 'monthly',
    hardLimitQuantity: '1000',
    enforcementMode: 'hard_block',
  }).success, false);
});

test('post-consumption Vapi metrics cannot promise a pre-dispatch hard block', () => {
  assert.equal(tenantBudgetInputSchema.safeParse({
    metric: USAGE_METRICS.VAPI_LLM_COMPLETION_TOKENS,
    period: 'billing_period',
    hardLimitQuantity: '1000',
    enforcementMode: 'hard_block',
  }).success, false);
  assert.equal(tenantBudgetInputSchema.safeParse({
    metric: USAGE_METRICS.VAPI_LLM_COMPLETION_TOKENS,
    period: 'billing_period',
    softLimitQuantity: '1000',
    enforcementMode: 'alert',
  }).success, true);
});

test('Razorpay plan IDs must be unique across public plan keys', () => {
  const plan = completePlan();
  process.env.RAZORPAY_PLAN_CONFIG_JSON = JSON.stringify({
    starter: plan,
    growth: { ...plan, amountMinor: 99900 },
  });

  assert.throws(() => getRazorpayPlans(), /plan IDs must be unique/);
});

test('plan matching requires the exact configured Razorpay plan ID', () => {
  assert.equal(planKeyForRazorpayPlanId('plan_00000000000001'), 'starter');
  assert.equal(planKeyForRazorpayPlanId('plan_00000000000002'), null);
});

test('the local rate parser preserves precise unit quantities', () => {
  const parsed = parseConfiguredPriceVersions(JSON.stringify([{
    planKey: 'starter',
    metric: USAGE_METRICS.VAPI_LLM_PROMPT_TOKENS,
    version: '2026-07-01',
    currency: 'INR',
    unitAmountMinor: '7',
    unitQuantity: '1000.5',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: null,
  }]));

  assert.equal(parsed[0].unitAmountMinor, 7n);
  assert.equal(parsed[0].unitQuantity.toFixed(), '1000.5');
});

test('the local rate parser rejects duplicate immutable versions', () => {
  const entry = {
    planKey: 'starter',
    metric: USAGE_METRICS.VOICE_SECONDS,
    version: '2026-07-01',
    currency: 'INR',
    unitAmountMinor: '2',
    unitQuantity: '1',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: null,
  };

  assert.throws(
    () => parseConfiguredPriceVersions(JSON.stringify([entry, entry])),
    PriceCatalogConfigurationError
  );
});
