import { prisma } from '../lib/prisma';
import { getOperationsConfig } from '../config/operations';

async function writeHeartbeat(name: string, lastStartedAt: Date | null) {
  const now = new Date();
  return prisma.workerHeartbeat.upsert({
    where: { name },
    create: {
      name,
      lastStartedAt: lastStartedAt ?? now,
      lastSeenAt: now,
    },
    update: {
      lastSeenAt: now,
      ...(lastStartedAt ? { lastStartedAt } : {}),
    },
  });
}

export async function assertFreshWorkerHeartbeat() {
  const config = getOperationsConfig();
  if (!config.requireForReadiness) return;

  const cutoff = new Date(Date.now() - config.maxAgeSeconds * 1_000);
  const heartbeat = await prisma.workerHeartbeat.findFirst({
    where: {
      name: config.workerName,
      lastSeenAt: { gte: cutoff },
    },
    select: { name: true },
  });
  if (!heartbeat) throw new Error('Background worker heartbeat is stale or missing');
}

export async function startWorkerHeartbeat(): Promise<() => Promise<void>> {
  const config = getOperationsConfig();
  const startedAt = new Date();
  await writeHeartbeat(config.workerName, startedAt);

  let stopped = false;
  let activeWrite: Promise<unknown> | null = null;
  const trigger = () => {
    if (stopped || activeWrite) return;
    activeWrite = writeHeartbeat(config.workerName, null)
      .catch(error => {
        console.error('Worker heartbeat update failed', {
          message: error instanceof Error ? error.message : 'unknown error',
        });
      })
      .finally(() => {
        activeWrite = null;
      });
  };

  const timer = setInterval(trigger, config.intervalSeconds * 1_000);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeWrite;
  };
}
