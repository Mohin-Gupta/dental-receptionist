import { getOperationsConfig } from '../config/operations';
import { prisma } from '../lib/prisma';

function expectedMaxAgeSeconds(intervalMs: number): number {
  return Math.max(60, Math.ceil(intervalMs / 1_000) * 2 + 60);
}

export async function recordWorkerTaskStarted(name: string, intervalMs: number): Promise<void> {
  const now = new Date();
  await prisma.workerTaskStatus.upsert({
    where: { name },
    create: {
      name,
      workerName: getOperationsConfig().workerName,
      expectedMaxAgeSeconds: expectedMaxAgeSeconds(intervalMs),
      lastStartedAt: now,
    },
    update: {
      workerName: getOperationsConfig().workerName,
      expectedMaxAgeSeconds: expectedMaxAgeSeconds(intervalMs),
      lastStartedAt: now,
    },
  });
}

export async function recordWorkerTaskSucceeded(name: string): Promise<void> {
  await prisma.workerTaskStatus.update({
    where: { name },
    data: {
      lastSucceededAt: new Date(),
      consecutiveFailures: 0,
      lastErrorCode: null,
    },
  });
}

export async function recordWorkerTaskFailed(name: string, error: unknown): Promise<void> {
  await prisma.workerTaskStatus.update({
    where: { name },
    data: {
      lastFailedAt: new Date(),
      consecutiveFailures: { increment: 1 },
      // Persist a class/code only. Provider messages can echo customer data.
      lastErrorCode: error instanceof Error ? error.name.slice(0, 100) : 'UnknownError',
    },
  });
}
