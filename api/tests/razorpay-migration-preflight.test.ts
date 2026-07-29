import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migration = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20260729100000_razorpay_billing_provider/migration.sql'
  ),
  'utf8'
);

test('Razorpay cutover preflight runs before provider schema DDL', () => {
  const preflight = migration.indexOf('DO $$');
  const firstAlter = migration.indexOf('ALTER TABLE "BillingAccount"');

  assert.ok(preflight >= 0, 'expected a cutover preflight block');
  assert.ok(firstAlter > preflight, 'cutover preflight must run before the first schema change');
});

test('Razorpay cutover refuses every Stripe state that still needs the old runtime', () => {
  for (const expected of [
    'FROM "SubscriptionMirror"',
    '"activeKey" IS NOT NULL',
    "('canceled', 'incomplete_expired')",
    'FROM "BillingCheckoutSession"',
    "('completed', 'expired', 'failed', 'superseded')",
    'FROM "UsageExport"',
    '"status" <> \'exported\'',
    'FROM "ProviderWebhookEvent"',
    '"status" <> \'processed\'',
  ]) {
    assert.match(migration, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Razorpay cutover preserves Stripe history without retaining its controller claim', () => {
  assert.match(
    migration,
    /UPDATE "BillingAccount"\s+SET "activeKey" = NULL\s+WHERE "billingProvider" = 'stripe';/
  );
});
