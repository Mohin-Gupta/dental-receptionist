import 'dotenv/config';
import { cleanupConsumedAuthTokens } from './auth/tokenCleanup';
import {
  exportPendingStripeUsage,
  expireElapsedBillingGrace,
  processTenantBudgetAlerts,
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
      'Billing grace expiry',
      5 * 60 * 1000,
      () => expireElapsedBillingGrace(250)
    ),
    startNonOverlappingTask(
      'Authentication token cleanup',
      15 * 60 * 1000,
      cleanupConsumedAuthTokens
    ),
    startNonOverlappingTask(
      'Sensitive payload retention',
      60 * 60 * 1000,
      () => runSensitiveDataRetention(500)
    ),
    startNonOverlappingTask(
      'Provider usage reconciliation',
      5 * 60 * 1000,
      () => reconcileStaleProviderAttempts()
    ),
    startNonOverlappingTask(
      'Tenant budget alerts',
      5 * 60 * 1000,
      processTenantBudgetAlerts
    ),
  ];

  const billingMaintenanceEnabled =
    process.env.BILLING_MAINTENANCE_ENABLED !== 'false' &&
    Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PLAN_CONFIG_JSON);
  if (billingMaintenanceEnabled) {
    stopTasks.push(startNonOverlappingTask(
      'Stripe usage export',
      30 * 1000,
      () => exportPendingStripeUsage(250)
    ));
  }

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
