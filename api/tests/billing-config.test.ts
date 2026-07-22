import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';
import { tenantBudgetInputSchema } from '../src/billing/budgets';
import { getStripePlans, planKeyForPriceIds } from '../src/billing/config';
import { USAGE_METRICS, USAGE_METRIC_VALUES } from '../src/billing/metrics';
import {
  PriceCatalogConfigurationError,
  parseConfiguredPriceVersions,
} from '../src/billing/priceCatalog';

const originalPlanConfig = process.env.STRIPE_PLAN_CONFIG_JSON;

function completePlan() {
  return {
    currency: 'INR',
    basePriceId: 'price_Base',
    licensedPrices: [],
    meteredPriceIds: Object.fromEntries(
      USAGE_METRIC_VALUES.map((metric, index) => [metric, `price_Metric${index}`])
    ),
    meterEventNames: Object.fromEntries(
      USAGE_METRIC_VALUES.map(metric => [metric, metric])
    ),
    entitlements: {
      'appointments.write': true,
      'communications.voice': true,
      'communications.sms': true,
    },
    trialDays: 14,
  };
}

beforeEach(() => {
  process.env.STRIPE_PLAN_CONFIG_JSON = JSON.stringify({ starter: completePlan() });
});

afterEach(() => {
  if (originalPlanConfig === undefined) delete process.env.STRIPE_PLAN_CONFIG_JSON;
  else process.env.STRIPE_PLAN_CONFIG_JSON = originalPlanConfig;
});

test('the billing plan accepts every metric emitted by production usage paths', () => {
  const plan = getStripePlans().starter;
  assert.deepEqual(Object.keys(plan.meteredPriceIds).sort(), [...USAGE_METRIC_VALUES].sort());
  assert.deepEqual(Object.keys(plan.meterEventNames).sort(), [...USAGE_METRIC_VALUES].sort());
});

test('a plan must pair each metered price with one meter event name', () => {
  const plan = completePlan();
  delete plan.meterEventNames[USAGE_METRICS.VOICE_SECONDS];
  process.env.STRIPE_PLAN_CONFIG_JSON = JSON.stringify({ starter: plan });

  assert.throws(() => getStripePlans(), /meter event name is required/);
});

test('enabled communication features cannot omit usage their runtime can emit', () => {
  const plan = completePlan();
  delete plan.meteredPriceIds[USAGE_METRICS.VAPI_TTS_CHARACTERS];
  delete plan.meterEventNames[USAGE_METRICS.VAPI_TTS_CHARACTERS];
  process.env.STRIPE_PLAN_CONFIG_JSON = JSON.stringify({ starter: plan });

  assert.throws(() => getStripePlans(), /require metered usage metric vapi_tts_characters/);
});

test('unimplemented usage dimensions cannot enter plan or budget configuration', () => {
  const plan = completePlan();
  (plan.meteredPriceIds as Record<string, string>).compute_milliseconds = 'price_Compute';
  (plan.meterEventNames as Record<string, string>).compute_milliseconds = 'compute_milliseconds';
  process.env.STRIPE_PLAN_CONFIG_JSON = JSON.stringify({ starter: plan });

  assert.throws(() => getStripePlans(), /Invalid STRIPE_PLAN_CONFIG_JSON/);
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

test('plan matching requires the exact recurring Stripe price set', () => {
  const plan = completePlan();
  const allPrices = [plan.basePriceId, ...Object.values(plan.meteredPriceIds)];

  assert.equal(planKeyForPriceIds(allPrices), 'starter');
  assert.equal(planKeyForPriceIds(allPrices.slice(0, -1)), null);
  assert.equal(planKeyForPriceIds([...allPrices, 'price_Unexpected']), null);
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
