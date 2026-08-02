import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { getOperationsConfig } from '../config/operations';
import { prisma } from '../lib/prisma';
import {
  CURRENT_WORKER_TASK_NAMES,
  evaluateCurrentWorkerTasks,
  PROCESSING_STALE_AFTER_SECONDS,
  RAZORPAY_CHECKOUT_STALE_AFTER_SECONDS,
  RAZORPAY_WEBHOOK_BACKLOG_GRACE_SECONDS,
  razorpayWebhookBacklogWhere,
  razorpayOperationsNeedAttention,
} from '../ops/operationsHealth';

const router = Router();
const RAZORPAY_PROVIDER = 'razorpay';

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
  const staleWorkItemCutoff = new Date(
    generatedAt.getTime() - PROCESSING_STALE_AFTER_SECONDS * 1_000
  );
  const razorpayWebhookBacklogCutoff = new Date(
    generatedAt.getTime() - RAZORPAY_WEBHOOK_BACKLOG_GRACE_SECONDS * 1_000
  );
  const razorpayCheckoutStaleCutoff = new Date(
    generatedAt.getTime() - RAZORPAY_CHECKOUT_STALE_AFTER_SECONDS * 1_000
  );

  try {
    const [
      heartbeat,
      outboxDeadLetter,
      outboxStale,
      webhookQuarantined,
      webhookStale,
      razorpayWebhookBacklog,
      razorpayWebhookOverdue,
      razorpayWebhookQuarantined,
      razorpayWebhookStale,
      staleRazorpayCheckoutCreating,
      expiredRazorpayCheckoutOpen,
      staleRazorpayCheckoutVerified,
      budgetAlertDeadLetter,
      budgetAlertStale,
      budgetAlertEvaluationIssues,
      budgetAlertOverdue,
      unfinalizedRetailAttempts,
      workerTasks,
    ] = await prisma.$transaction([
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
      prisma.providerWebhookEvent.count({
        where: razorpayWebhookBacklogWhere(),
      }),
      prisma.providerWebhookEvent.count({
        where: razorpayWebhookBacklogWhere(razorpayWebhookBacklogCutoff),
      }),
      prisma.providerWebhookEvent.count({
        where: {
          provider: RAZORPAY_PROVIDER,
          signatureValid: true,
          status: 'quarantined',
        },
      }),
      prisma.providerWebhookEvent.count({
        where: {
          provider: RAZORPAY_PROVIDER,
          signatureValid: true,
          status: 'processing',
          processingStartedAt: { lt: staleWorkItemCutoff },
        },
      }),
      prisma.billingCheckoutSession.count({
        where: {
          billingProvider: RAZORPAY_PROVIDER,
          activeKey: 'active',
          status: 'creating',
          updatedAt: { lt: razorpayCheckoutStaleCutoff },
        },
      }),
      prisma.billingCheckoutSession.count({
        where: {
          billingProvider: RAZORPAY_PROVIDER,
          activeKey: 'active',
          status: 'open',
          expiresAt: { lt: razorpayCheckoutStaleCutoff },
        },
      }),
      prisma.billingCheckoutSession.count({
        where: {
          billingProvider: RAZORPAY_PROVIDER,
          activeKey: 'active',
          status: 'verified',
          updatedAt: { lt: razorpayCheckoutStaleCutoff },
        },
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
      prisma.workerTaskStatus.findMany({
        where: {
          workerName: config.workerName,
          name: { in: [...CURRENT_WORKER_TASK_NAMES] },
        },
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
    const workerTaskStatus = evaluateCurrentWorkerTasks(workerTasks, generatedAt);
    const staleRazorpayCheckoutIntents =
      staleRazorpayCheckoutCreating +
      expiredRazorpayCheckoutOpen +
      staleRazorpayCheckoutVerified;
    const razorpayNeedsAttention = razorpayOperationsNeedAttention({
      webhookBacklog: razorpayWebhookBacklog,
      overdueWebhookBacklog: razorpayWebhookOverdue,
      quarantinedWebhooks: razorpayWebhookQuarantined,
      staleWebhookProcessing: razorpayWebhookStale,
      staleCheckoutIntents: staleRazorpayCheckoutIntents,
    });
    const needsAttention =
      !workerFresh ||
      workerTaskStatus.unhealthy ||
      outboxDeadLetter > 0 ||
      outboxStale > 0 ||
      webhookQuarantined > 0 ||
      webhookStale > 0 ||
      razorpayNeedsAttention ||
      budgetAlertDeadLetter > 0 ||
      budgetAlertStale > 0 ||
      budgetAlertEvaluationIssues > 0 ||
      budgetAlertOverdue > 0 ||
      unfinalizedRetailAttempts > 0;

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
        expectedTaskNames: CURRENT_WORKER_TASK_NAMES,
        missingTaskNames: workerTaskStatus.missingTaskNames,
        tasks: workerTaskStatus.tasks.map(task => ({
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
        staleAfterSeconds: PROCESSING_STALE_AFTER_SECONDS,
        outbox: { deadLetter: outboxDeadLetter, staleProcessing: outboxStale },
        providerWebhooks: {
          quarantined: webhookQuarantined,
          staleProcessing: webhookStale,
          razorpay: {
            backlog: razorpayWebhookBacklog,
            overdueBacklog: razorpayWebhookOverdue,
            backlogGraceSeconds: RAZORPAY_WEBHOOK_BACKLOG_GRACE_SECONDS,
            quarantined: razorpayWebhookQuarantined,
            staleProcessing: razorpayWebhookStale,
            processingStaleAfterSeconds: PROCESSING_STALE_AFTER_SECONDS,
          },
        },
        billingCheckoutIntents: {
          razorpay: {
            staleAfterSeconds: RAZORPAY_CHECKOUT_STALE_AFTER_SECONDS,
            staleCreating: staleRazorpayCheckoutCreating,
            expiredOpen: expiredRazorpayCheckoutOpen,
            awaitingProjection: staleRazorpayCheckoutVerified,
            staleTotal: staleRazorpayCheckoutIntents,
          },
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
