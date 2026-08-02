import type { Prisma } from '@prisma/client';

export const CURRENT_WORKER_TASKS = {
  billingGraceExpiry: {
    name: 'Billing grace expiry',
    intervalMs: 5 * 60_000,
  },
  razorpayCancellationReconciliation: {
    name: 'Razorpay cancellation reconciliation',
    intervalMs: 5 * 60_000,
  },
  razorpayCheckoutReconciliation: {
    name: 'Razorpay checkout reconciliation',
    intervalMs: 5 * 60_000,
  },
  authenticationTokenCleanup: {
    name: 'Authentication token cleanup',
    intervalMs: 15 * 60_000,
  },
  sensitivePayloadRetention: {
    name: 'Sensitive payload retention',
    intervalMs: 60 * 60_000,
  },
  providerUsageReconciliation: {
    name: 'Provider usage reconciliation',
    intervalMs: 5 * 60_000,
  },
  tenantBudgetAlerts: {
    name: 'Tenant budget alerts',
    intervalMs: 5 * 60_000,
  },
  razorpayWebhookProcessing: {
    name: 'Razorpay webhook processing',
    intervalMs: 5_000,
  },
} as const;

export const CURRENT_WORKER_TASK_NAMES = Object.freeze(
  Object.values(CURRENT_WORKER_TASKS).map(task => task.name)
);

export const PROCESSING_STALE_AFTER_SECONDS = 5 * 60;
export const RAZORPAY_WEBHOOK_BACKLOG_GRACE_SECONDS = 2 * 60;
export const RAZORPAY_CHECKOUT_STALE_AFTER_SECONDS = 5 * 60;

export function razorpayWebhookBacklogWhere(
  receivedBefore?: Date
): Prisma.ProviderWebhookEventWhereInput {
  // Health is based on end-to-end event age, not retry eligibility. In
  // particular, a failed event remains overdue while its next retry is backed
  // off into the future.
  return {
    provider: 'razorpay',
    signatureValid: true,
    payloadPurgedAt: null,
    status: { in: ['received', 'failed'] },
    ...(receivedBefore ? { receivedAt: { lt: receivedBefore } } : {}),
  };
}

export interface WorkerTaskSnapshot {
  name: string;
  expectedMaxAgeSeconds: number;
  lastStartedAt: Date;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
}

export interface WorkerTaskHealth extends WorkerTaskSnapshot {
  ageSeconds: number;
  stale: boolean;
}

export function evaluateCurrentWorkerTasks(
  snapshots: readonly WorkerTaskSnapshot[],
  generatedAt: Date
): {
  tasks: WorkerTaskHealth[];
  missingTaskNames: string[];
  unhealthy: boolean;
} {
  const expectedNames = new Set<string>(CURRENT_WORKER_TASK_NAMES);
  const currentSnapshots = snapshots.filter(task => expectedNames.has(task.name));
  const presentNames = new Set(currentSnapshots.map(task => task.name));
  const missingTaskNames = CURRENT_WORKER_TASK_NAMES.filter(
    name => !presentNames.has(name)
  );
  const tasks = currentSnapshots.map(task => {
    const reference = task.lastSucceededAt ?? task.lastStartedAt;
    const ageSeconds = Math.max(
      0,
      Math.floor((generatedAt.getTime() - reference.getTime()) / 1_000)
    );
    return {
      ...task,
      ageSeconds,
      stale: ageSeconds > task.expectedMaxAgeSeconds,
    };
  });

  return {
    tasks,
    missingTaskNames,
    unhealthy: missingTaskNames.length > 0 ||
      tasks.some(task => task.stale || task.consecutiveFailures > 0),
  };
}

export function razorpayOperationsNeedAttention(input: {
  webhookBacklog: number;
  overdueWebhookBacklog: number;
  quarantinedWebhooks: number;
  staleWebhookProcessing: number;
  staleCheckoutIntents: number;
}): boolean {
  return input.overdueWebhookBacklog > 0 ||
    input.quarantinedWebhooks > 0 ||
    input.staleWebhookProcessing > 0 ||
    input.staleCheckoutIntents > 0;
}
