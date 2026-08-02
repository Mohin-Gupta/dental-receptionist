import 'dotenv/config';
import { cleanupExpiredAuthenticationState } from './auth/tokenCleanup';
import {
  expireElapsedBillingGrace,
  processPendingRazorpayWebhooks,
  processTenantBudgetAlerts,
  reconcileEndedRazorpayCancellations,
  reconcilePendingRazorpayCancellations,
  reconcileStaleRazorpayCheckoutSessions,
  syncConfiguredPriceVersions,
} from './billing';
import { validateRuntimeConfiguration } from './config/runtime';
import { prisma } from './lib/prisma';
import { runSensitiveDataRetention } from './services/dataRetention';
import { startOutboxWorker } from './queues/outboxWorker';
import { reminderQueue } from './queues/reminderQueue';
import { startReminderWorker } from './queues/reminderWorker';
import {
  scheduleAppointmentStatusUpdater,
  scheduleDailyAgenda,
} from './queues/repeatableJobs';
import { reconcileStaleProviderAttempts } from './queues/jobs/providerReconciliationJob';
import { startWorkerHeartbeat } from './ops/workerHeartbeat';
import {
  recordWorkerTaskFailed,
  recordWorkerTaskStarted,
  recordWorkerTaskSucceeded,
} from './ops/workerTaskStatus';
import { CURRENT_WORKER_TASKS } from './ops/operationsHealth';

validateRuntimeConfiguration('worker');

function startNonOverlappingTask(
  name: string,
  intervalMs: number,
  task: () => Promise<unknown>,
  runImmediately = true
) {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await recordWorkerTaskStarted(name, intervalMs);
    } catch {
      console.error(`${name} task-health start update failed`);
    }
    try {
      await task();
      try {
        await recordWorkerTaskSucceeded(name);
      } catch {
        console.error(`${name} task-health success update failed`);
      }
    } catch (error) {
      try {
        await recordWorkerTaskFailed(name, error);
      } catch {
        console.error(`${name} task-health failure update failed`);
      }
      console.error(`${name} failed`, {
        message: error instanceof Error ? error.message : 'unknown error',
      });
    } finally {
      running = false;
    }
  };
  if (runImmediately) void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  if (process.env.NODE_ENV === 'production' || process.env.BILLING_PRICE_VERSIONS_JSON) {
    await syncConfiguredPriceVersions();
  }
  const reminderWorker = startReminderWorker();
  const stopOutboxWorker = startOutboxWorker();
  await scheduleDailyAgenda();
  await scheduleAppointmentStatusUpdater();

  const stopTasks = [
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.billingGraceExpiry.name,
      CURRENT_WORKER_TASKS.billingGraceExpiry.intervalMs,
      () => expireElapsedBillingGrace(250)
    ),
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.razorpayCancellationReconciliation.name,
      CURRENT_WORKER_TASKS.razorpayCancellationReconciliation.intervalMs,
      async () => {
        await reconcilePendingRazorpayCancellations(100);
        return reconcileEndedRazorpayCancellations(100);
      }
    ),
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.razorpayCheckoutReconciliation.name,
      CURRENT_WORKER_TASKS.razorpayCheckoutReconciliation.intervalMs,
      () => reconcileStaleRazorpayCheckoutSessions(100)
    ),
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.authenticationTokenCleanup.name,
      CURRENT_WORKER_TASKS.authenticationTokenCleanup.intervalMs,
      cleanupExpiredAuthenticationState
    ),
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.sensitivePayloadRetention.name,
      CURRENT_WORKER_TASKS.sensitivePayloadRetention.intervalMs,
      () => runSensitiveDataRetention(500)
    ),
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.providerUsageReconciliation.name,
      CURRENT_WORKER_TASKS.providerUsageReconciliation.intervalMs,
      () => reconcileStaleProviderAttempts()
    ),
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.tenantBudgetAlerts.name,
      CURRENT_WORKER_TASKS.tenantBudgetAlerts.intervalMs,
      processTenantBudgetAlerts
    ),
    startNonOverlappingTask(
      CURRENT_WORKER_TASKS.razorpayWebhookProcessing.name,
      CURRENT_WORKER_TASKS.razorpayWebhookProcessing.intervalMs,
      () => processPendingRazorpayWebhooks(100)
    ),
  ];

  // Publish freshness only after every worker component initialized. This
  // prevents API readiness from passing while startup is still incomplete.
  const stopWorkerHeartbeat = await startWorkerHeartbeat();
  console.log('Background workers are ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Worker received ${signal}; shutting down`);
    stopTasks.forEach(stop => stop());
    await Promise.allSettled([
      stopOutboxWorker(),
      stopWorkerHeartbeat(),
      reminderWorker.close(),
      reminderQueue.close(),
    ]);
    await prisma.$disconnect();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(error => {
  console.error('Worker startup failed', {
    message: error instanceof Error ? error.message : 'unknown error',
  });
  process.exit(1);
});
