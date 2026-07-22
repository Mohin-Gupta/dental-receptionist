import { Prisma } from '@prisma/client';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alertThresholds,
  amountThresholdReached,
  periodFor,
  quantityThresholdReached,
} from '../src/billing/budgetAlerts';
import { tenantBudgetInputSchema } from '../src/billing/budgets';

test('budget warning percentages are calculated against a positive warning limit', () => {
  const warning = new Prisma.Decimal('3000');
  assert.equal(quantityThresholdReached(new Prisma.Decimal('1499.999999'), warning, 50), false);
  assert.equal(quantityThresholdReached(new Prisma.Decimal('1500'), warning, 50), true);
  assert.equal(quantityThresholdReached(new Prisma.Decimal('-1'), warning, 1), false);
});

test('amount threshold math preserves fractional minor units', () => {
  assert.equal(amountThresholdReached(new Prisma.Decimal('749.999'), 1_000n, 75), false);
  assert.equal(amountThresholdReached(new Prisma.Decimal('750'), 1_000n, 75), true);
  assert.equal(amountThresholdReached(new Prisma.Decimal('-100'), 1_000n, 1), false);
});

test('alert thresholds are de-duplicated, validated, and ordered', () => {
  assert.deepEqual(alertThresholds([100, 50, 50, 0, 101, '75']), [50, 100]);
});

test('calendar budget periods have explicit UTC boundaries', () => {
  const now = new Date('2026-07-13T17:45:00.000Z');
  assert.deepEqual(periodFor('daily', now, null), {
    start: new Date('2026-07-13T00:00:00.000Z'),
    end: new Date('2026-07-14T00:00:00.000Z'),
  });
  assert.deepEqual(periodFor('monthly', now, null), {
    start: new Date('2026-07-01T00:00:00.000Z'),
    end: new Date('2026-08-01T00:00:00.000Z'),
  });
  assert.equal(periodFor('billing_period', now, null), null);
});

test('budget input rejects zero limits and normalizes an alphabetic currency', () => {
  assert.equal(tenantBudgetInputSchema.safeParse({
    metric: 'voice_seconds',
    hardLimitQuantity: '0',
  }).success, false);
  assert.equal(tenantBudgetInputSchema.safeParse({
    metric: 'voice_seconds',
    softLimitAmountMinor: '0',
    currency: 'INR',
  }).success, false);

  const valid = tenantBudgetInputSchema.parse({
    metric: 'voice_seconds',
    softLimitAmountMinor: '100',
    currency: 'inr',
  });
  assert.equal(valid.currency, 'INR');
  assert.equal(tenantBudgetInputSchema.safeParse({
    metric: 'voice_seconds',
    softLimitAmountMinor: '100',
    currency: '1NR',
  }).success, false);
});
