import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_WORKER_TASK_NAMES,
  evaluateCurrentWorkerTasks,
  razorpayWebhookBacklogWhere,
  razorpayOperationsNeedAttention,
  type WorkerTaskSnapshot,
} from '../src/ops/operationsHealth';

const GENERATED_AT = new Date('2026-07-29T12:00:00.000Z');

test('tracks period-end Razorpay cancellation reconciliation as a current worker task', () => {
  assert.equal(
    CURRENT_WORKER_TASK_NAMES.includes('Razorpay cancellation reconciliation'),
    true
  );
});

function taskSnapshot(
  name: string,
  overrides: Partial<WorkerTaskSnapshot> = {}
): WorkerTaskSnapshot {
  return {
    name,
    expectedMaxAgeSeconds: 600,
    lastStartedAt: new Date('2026-07-29T11:59:00.000Z'),
    lastSucceededAt: new Date('2026-07-29T11:59:30.000Z'),
    lastFailedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

test('retired worker-task rows cannot make the current worker unhealthy', () => {
  const currentTasks = CURRENT_WORKER_TASK_NAMES.map(name => taskSnapshot(name));
  const legacyTask = taskSnapshot('Stripe usage export', {
    expectedMaxAgeSeconds: 60,
    lastStartedAt: new Date('2026-07-01T00:00:00.000Z'),
    lastSucceededAt: new Date('2026-07-01T00:00:00.000Z'),
    consecutiveFailures: 20,
    lastErrorCode: 'LegacyExporterError',
  });

  const health = evaluateCurrentWorkerTasks(
    [...currentTasks, legacyTask],
    GENERATED_AT
  );

  assert.equal(health.unhealthy, false);
  assert.deepEqual(health.missingTaskNames, []);
  assert.deepEqual(
    health.tasks.map(task => task.name).sort(),
    [...CURRENT_WORKER_TASK_NAMES].sort()
  );
  assert.equal(
    health.tasks.some(task => task.name === 'Stripe usage export'),
    false
  );
});

test('missing or stale current worker tasks still require attention', () => {
  const currentTasks = CURRENT_WORKER_TASK_NAMES.map(name => taskSnapshot(name));
  const missingName = CURRENT_WORKER_TASK_NAMES[0];
  const withoutOneTask = currentTasks.filter(task => task.name !== missingName);

  const missing = evaluateCurrentWorkerTasks(withoutOneTask, GENERATED_AT);
  assert.equal(missing.unhealthy, true);
  assert.deepEqual(missing.missingTaskNames, [missingName]);

  const stale = evaluateCurrentWorkerTasks(
    currentTasks.map((task, index) => index === 0
      ? taskSnapshot(task.name, {
          expectedMaxAgeSeconds: 60,
          lastSucceededAt: new Date('2026-07-29T11:50:00.000Z'),
        })
      : task),
    GENERATED_AT
  );
  assert.equal(stale.unhealthy, true);
  assert.equal(stale.tasks.find(task => task.name === missingName)?.stale, true);
});

test('Razorpay backlog alerts only after grace or on terminal operational failures', () => {
  assert.equal(razorpayOperationsNeedAttention({
    webhookBacklog: 25,
    overdueWebhookBacklog: 0,
    quarantinedWebhooks: 0,
    staleWebhookProcessing: 0,
    staleCheckoutIntents: 0,
  }), false);

  assert.equal(razorpayOperationsNeedAttention({
    webhookBacklog: 1,
    overdueWebhookBacklog: 1,
    quarantinedWebhooks: 0,
    staleWebhookProcessing: 0,
    staleCheckoutIntents: 0,
  }), true);
  assert.equal(razorpayOperationsNeedAttention({
    webhookBacklog: 0,
    overdueWebhookBacklog: 0,
    quarantinedWebhooks: 1,
    staleWebhookProcessing: 0,
    staleCheckoutIntents: 0,
  }), true);
  assert.equal(razorpayOperationsNeedAttention({
    webhookBacklog: 0,
    overdueWebhookBacklog: 0,
    quarantinedWebhooks: 0,
    staleWebhookProcessing: 1,
    staleCheckoutIntents: 0,
  }), true);
  assert.equal(razorpayOperationsNeedAttention({
    webhookBacklog: 0,
    overdueWebhookBacklog: 0,
    quarantinedWebhooks: 0,
    staleWebhookProcessing: 0,
    staleCheckoutIntents: 1,
  }), true);
});

test('Razorpay failed webhooks become overdue by receipt age even during backoff', () => {
  const cutoff = new Date('2026-07-29T11:58:00.000Z');

  assert.deepEqual(razorpayWebhookBacklogWhere(cutoff), {
    provider: 'razorpay',
    signatureValid: true,
    payloadPurgedAt: null,
    status: { in: ['received', 'failed'] },
    receivedAt: { lt: cutoff },
  });
});
