import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';

/**
 * reminderQueue.ts — the Queue instance and the two functions every other
 * part of the app calls into: scheduleReminders() and cancelReminders().
 *
 * Everything else that used to live in this file has moved out:
 *   - Worker/job dispatch logic  → reminderWorker.ts
 *   - Individual job handlers    → jobs/*.ts
 *   - Cron-style repeatable jobs → repeatableJobs.ts
 *
 * Import reminderWorker.ts once at app startup (see index.ts) to actually
 * start processing jobs — this file alone only lets you enqueue/cancel them.
 */

const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const reminderQueue = new Queue('reminders', { connection });

// ── Schedule reminders after booking ─────────────────────────────────────────

export async function scheduleReminders(
  appointmentId: string,
  // Kept temporarily for source compatibility. PHI and timestamps supplied by
  // callers are deliberately ignored; workers reload the appointment.
  _patientPhone?: string,
  _patientName?: string,
  _clinicName?: string,
  _startAt?: Date
): Promise<void> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      organizationId: true,
      clinicId: true,
      startAt: true,
      status: true,
    },
  });
  if (!appointment) throw new Error('Cannot schedule reminders for an unknown appointment');
  if (!['scheduled', 'confirmed'].includes(appointment.status)) return;

  const now = Date.now();
  const ms60min = appointment.startAt.getTime() - 60 * 60 * 1000;
  const msFeedback = appointment.startAt.getTime() + 60 * 60 * 1000;

  const schedule = async (
    type: '60min' | 'feedback',
    channel: 'call' | 'sms',
    scheduledAtMs: number,
    attempts: number
  ): Promise<void> => {
    if (scheduledAtMs <= now) return;

    const bullJobId = `${type}-${appointment.id}`;
    const existing = await prisma.reminderJob.findUnique({
      where: { bullJobId },
      select: { status: true },
    });
    if (existing && ['sent', 'cancelled', 'skipped'].includes(existing.status)) return;

    await prisma.reminderJob.upsert({
      where: { bullJobId },
      create: {
        organizationId: appointment.organizationId,
        clinicId: appointment.clinicId,
        appointmentId: appointment.id,
        type,
        channel,
        bullJobId,
        scheduledAt: new Date(scheduledAtMs),
        status: 'pending',
      },
      update: {
        scheduledAt: new Date(scheduledAtMs),
        status: 'pending',
        sentAt: null,
      },
    });

    try {
      await reminderQueue.add(
        type === '60min' ? '60min-reminder' : 'feedback-sms',
        { appointmentId: appointment.id, type },
        {
          delay: scheduledAtMs - now,
          attempts,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: bullJobId,
          removeOnComplete: { age: 7 * 24 * 60 * 60 },
          removeOnFail: { age: 30 * 24 * 60 * 60 },
        }
      );
    } catch (error) {
      await prisma.reminderJob.update({
        where: { bullJobId },
        data: { status: 'schedule_failed' },
      });
      throw error;
    }
  };

  if (ms60min > now) {
    await schedule('60min', 'call', ms60min, 3);
  }

  if (msFeedback > now) {
    await schedule('feedback', 'sms', msFeedback, 2);
  }
}

// ── Cancel reminders (on cancel or reschedule) ────────────────────────────────

export async function cancelReminders(appointmentId: string): Promise<void> {
  try {
    await prisma.reminderJob.updateMany({
      where: {
        appointmentId,
        status: { in: ['pending', 'processing', 'failed', 'schedule_failed'] },
      },
      data: { status: 'cancelled' },
    });

    const job60 = await reminderQueue.getJob(`60min-${appointmentId}`);
    if (job60) await job60.remove();

    const jobFeedback = await reminderQueue.getJob(`feedback-${appointmentId}`);
    if (jobFeedback) await jobFeedback.remove();

  } catch (error) {
    // Cancellation is an important side effect. Propagate failure so the
    // caller can retry instead of silently leaving a patient reminder active.
    throw error;
  }
}
