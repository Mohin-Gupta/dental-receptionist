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
  patientPhone: string,
  patientName: string,
  clinicName: string,
  startAt: Date
): Promise<void> {
  const now = Date.now();
  const ms60min    = startAt.getTime() - 60 * 60 * 1000;
  const msFeedback = startAt.getTime() + 60 * 60 * 1000;

  if (ms60min > now) {
    const job = await reminderQueue.add(
      '60min-reminder',
      { appointmentId, patientPhone, patientName, clinicName, type: '60min' },
      {
        delay: ms60min - now,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
        jobId: `60min-${appointmentId}`,
      }
    );

    await prisma.reminderJob.create({
      data: {
        appointmentId,
        type: '60min',
        channel: 'call',
        bullJobId: job.id ?? undefined,
        scheduledAt: new Date(ms60min),
        status: 'pending',
      },
    });

    console.log(`60-min reminder scheduled ✓ fires at ${new Date(ms60min).toISOString()}`);
  } else {
    console.log('Appointment is within 60 minutes — skipping reminder job');
  }

  if (msFeedback > now) {
    const feedbackJob = await reminderQueue.add(
      'feedback-sms',
      { appointmentId, patientPhone, patientName, clinicName, type: 'feedback' },
      {
        delay: msFeedback - now,
        attempts: 2,
        backoff: { type: 'exponential', delay: 60000 },
        jobId: `feedback-${appointmentId}`,
      }
    );

    await prisma.reminderJob.create({
      data: {
        appointmentId,
        type: 'feedback',
        channel: 'sms',
        bullJobId: feedbackJob.id ?? undefined,
        scheduledAt: new Date(msFeedback),
        status: 'pending',
      },
    });

    console.log(`Feedback SMS scheduled ✓ fires at ${new Date(msFeedback).toISOString()}`);
  }
}

// ── Cancel reminders (on cancel or reschedule) ────────────────────────────────

export async function cancelReminders(appointmentId: string): Promise<void> {
  try {
    const job60 = await reminderQueue.getJob(`60min-${appointmentId}`);
    if (job60) await job60.remove();

    const jobFeedback = await reminderQueue.getJob(`feedback-${appointmentId}`);
    if (jobFeedback) await jobFeedback.remove();

    await prisma.reminderJob.updateMany({
      where: { appointmentId, status: 'pending' },
      data: { status: 'cancelled' },
    });

    console.log(`Reminders cancelled ✓ for ${appointmentId}`);
  } catch (err: any) {
    console.warn('Cancel reminders error:', err?.message);
  }
}