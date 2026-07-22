import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { getOperationsConfig } from '../config/operations';
import { prisma } from '../lib/prisma';

const router = Router();
const STALE_WORK_ITEM_SECONDS = 5 * 60;
const STRIPE_EXPORT_RISK_DAYS = 30;

function tokenDigest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function requireOperationsToken(req: Request, res: Response, next: NextFunction) {
  const expected = getOperationsConfig({
    requireBearerToken: process.env.NODE_ENV === 'production',
  }).bearerToken;
  if (!expected) return res.status(404).json({ error: 'Not found' });

  const match = /^Bearer ([^\s]+)$/.exec(req.header('authorization') ?? '');
  const supplied = match?.[1] ?? '';
  if (!crypto.timingSafeEqual(tokenDigest(supplied), tokenDigest(expected))) {
    res.setHeader('www-authenticate', 'Bearer');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.get('/ops/status', requireOperationsToken, async (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  const config = getOperationsConfig();
  const generatedAt = new Date();
  const heartbeatCutoff = new Date(generatedAt.getTime() - config.maxAgeSeconds * 1_000);
  const staleWorkItemCutoff = new Date(generatedAt.getTime() - STALE_WORK_ITEM_SECONDS * 1_000);
  const stripeExportRiskCutoff = new Date(
    generatedAt.getTime() - STRIPE_EXPORT_RISK_DAYS * 86_400_000
  );

  try {
    const [heartbeat, outboxDeadLetter, outboxStale, webhookQuarantined, webhookStale,
      usageExportQuarantined, usageExportStale, budgetAlertDeadLetter,
      budgetAlertStale, budgetAlertEvaluationIssues, budgetAlertOverdue,
      unfinalizedRetailAttempts, stripeUsageAtRisk, workerTasks] = await prisma.$transaction([
      prisma.workerHeartbeat.findUnique({
        where: { name: config.workerName },
        select: { name: true, lastStartedAt: true, lastSeenAt: true },
      }),
      prisma.outboxEvent.count({ where: { status: 'dead_letter' } }),
      prisma.outboxEvent.count({
        where: { status: 'processing', lockedAt: { lt: staleWorkItemCutoff } },
      }),
      prisma.providerWebhookEvent.count({ where: { status: 'quarantined' } }),
      prisma.providerWebhookEvent.count({
        where: { status: 'processing', processingStartedAt: { lt: staleWorkItemCutoff } },
      }),
      prisma.usageExport.count({ where: { status: 'quarantined' } }),
      prisma.usageExport.count({
        where: { status: 'processing', lastAttemptAt: { lt: staleWorkItemCutoff } },
      }),
      prisma.budgetAlertDelivery.count({ where: { status: 'dead_letter' } }),
      prisma.budgetAlertDelivery.count({
        where: { status: 'processing', lockedAt: { lt: staleWorkItemCutoff } },
      }),
      prisma.budgetAlertEvaluationIssue.count({ where: { status: 'active' } }),
      prisma.budgetAlertDelivery.count({
        where: {
          OR: [
            { status: 'pending', createdAt: { lt: staleWorkItemCutoff } },
            { status: 'failed', nextAttemptAt: { lt: staleWorkItemCutoff } },
          ],
        },
      }),
      prisma.communicationAttempt.count({
        where: {
          usageFinalizedAt: null,
          endedAt: { not: null, lt: staleWorkItemCutoff },
          provider: { in: ['vapi', 'twilio'] },
        },
      }),
      prisma.usageEvent.count({
        where: {
          occurredAt: { lt: stripeExportRiskCutoff },
          exports: { none: { billingProvider: 'stripe', status: 'exported' } },
        },
      }),
      prisma.workerTaskStatus.findMany({
        where: { workerName: config.workerName },
        orderBy: { name: 'asc' },
        select: {
          name: true,
          expectedMaxAgeSeconds: true,
          lastStartedAt: true,
          lastSucceededAt: true,
          lastFailedAt: true,
          consecutiveFailures: true,
          lastErrorCode: true,
        },
      }),
    ]);

    const workerFresh = Boolean(heartbeat && heartbeat.lastSeenAt >= heartbeatCutoff);
    const workerTaskHealth = workerTasks.map(task => {
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
    const workerTasksUnhealthy =
      workerTaskHealth.length === 0 ||
      workerTaskHealth.some(task => task.stale || task.consecutiveFailures > 0);
    const needsAttention =
      !workerFresh ||
      workerTasksUnhealthy ||
      outboxDeadLetter > 0 ||
      outboxStale > 0 ||
      webhookQuarantined > 0 ||
      webhookStale > 0 ||
      usageExportQuarantined > 0 ||
      usageExportStale > 0 ||
      budgetAlertDeadLetter > 0 ||
      budgetAlertStale > 0 ||
      budgetAlertEvaluationIssues > 0 ||
      budgetAlertOverdue > 0 ||
      unfinalizedRetailAttempts > 0 ||
      stripeUsageAtRisk > 0;

    return res.json({
      status: needsAttention ? 'attention_required' : 'ok',
      generatedAt: generatedAt.toISOString(),
      worker: {
        name: config.workerName,
        fresh: workerFresh,
        maxAgeSeconds: config.maxAgeSeconds,
        lastStartedAt: heartbeat?.lastStartedAt.toISOString() ?? null,
        lastSeenAt: heartbeat?.lastSeenAt.toISOString() ?? null,
        ageSeconds: heartbeat
          ? Math.max(0, Math.floor((generatedAt.getTime() - heartbeat.lastSeenAt.getTime()) / 1_000))
          : null,
        tasks: workerTaskHealth.map(task => ({
          name: task.name,
          expectedMaxAgeSeconds: task.expectedMaxAgeSeconds,
          ageSeconds: task.ageSeconds,
          stale: task.stale,
          consecutiveFailures: task.consecutiveFailures,
          lastErrorCode: task.lastErrorCode,
          lastStartedAt: task.lastStartedAt.toISOString(),
          lastSucceededAt: task.lastSucceededAt?.toISOString() ?? null,
          lastFailedAt: task.lastFailedAt?.toISOString() ?? null,
        })),
      },
      workItems: {
        staleAfterSeconds: STALE_WORK_ITEM_SECONDS,
        outbox: { deadLetter: outboxDeadLetter, staleProcessing: outboxStale },
        providerWebhooks: {
          quarantined: webhookQuarantined,
          staleProcessing: webhookStale,
        },
        usageExports: {
          quarantined: usageExportQuarantined,
          staleProcessing: usageExportStale,
          olderThanDaysUnexported: STRIPE_EXPORT_RISK_DAYS,
          atRisk: stripeUsageAtRisk,
        },
        budgetAlerts: {
          deadLetter: budgetAlertDeadLetter,
          staleProcessing: budgetAlertStale,
          evaluationIssues: budgetAlertEvaluationIssues,
          overdue: budgetAlertOverdue,
        },
        retailUsage: { unfinalizedTerminalAttempts: unfinalizedRetailAttempts },
      },
    });
  } catch {
    return res.status(503).json({ status: 'unavailable' });
  }
});

export default router;
