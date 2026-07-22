import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { runStatusUpdaterJob } from './jobs/statusUpdaterJob';
import { runDailyAgendaJob } from './jobs/dailyAgendaJob';
import { runSixtyMinReminderJob } from './jobs/sixtyMinReminderJob';
import { runFeedbackSmsJob } from './jobs/feedbackSmsJob';
import { prisma } from '../lib/prisma';

/**
 * reminderWorker.ts — thin dispatcher only. All actual job logic lives in
 * queues/jobs/*.ts — this file's only responsibility is routing job.data.type
 * to the correct handler. Previously this was ~250 lines with every job's
 * logic inlined; now each job type is independently readable and testable.
 */
export function startReminderWorker() {
  const reminderWorker = new Worker(
    'reminders',
    async (job: Job) => {
    const type = typeof job.data?.type === 'string' ? job.data.type : '';

    switch (type) {
      case 'status-update':
        await runStatusUpdaterJob();
        break;

      case 'agenda': {
        if (job.data.clinicId) {
          await runDailyAgendaJob(job.data.clinicId);
        } else if (job.data.organizationId) {
          const clinics = await prisma.clinic.findMany({
            where: {
              organizationId: job.data.organizationId,
              organization: { status: { in: ['active', 'past_due_grace'] } },
            },
            select: { id: true },
          });
          for (const clinic of clinics) {
            await runDailyAgendaJob(clinic.id);
          }
        } else {
          // The repeatable job is a tenant-free scanner. Authoritative clinic
          // ownership is loaded here instead of being frozen in queue payloads.
          const clinics = await prisma.clinic.findMany({
            where: {
              organization: { status: { in: ['active', 'past_due_grace'] } },
            },
            select: { id: true },
          });
          let failureCount = 0;
          // Bound concurrency so one scan cannot turn tenant growth into an
          // unbounded connection/provider burst.
          for (let index = 0; index < clinics.length; index += 5) {
            const results = await Promise.allSettled(
              clinics
                .slice(index, index + 5)
                .map((clinic) => runDailyAgendaJob(clinic.id))
            );
            failureCount += results.filter((result) => result.status === 'rejected').length;
          }
          if (failureCount > 0) {
            throw new Error(`Daily agenda failed for ${failureCount} clinic(s)`);
          }
        }
        break;
      }

      case '60min': {
        const appointmentId =
          typeof job.data.appointmentId === 'string' ? job.data.appointmentId : '';
        if (!appointmentId) throw new Error('60-minute reminder is missing appointmentId');
        await markReminder(job, appointmentId, type, 'processing');
        try {
          const outcome = await runSixtyMinReminderJob({ appointmentId });
          await markReminder(job, appointmentId, type, outcome, outcome === 'sent');
        } catch (error) {
          await markReminder(job, appointmentId, type, 'failed');
          throw error;
        }
        break;
      }

      case 'feedback': {
        const appointmentId =
          typeof job.data.appointmentId === 'string' ? job.data.appointmentId : '';
        if (!appointmentId) throw new Error('Feedback reminder is missing appointmentId');
        await markReminder(job, appointmentId, type, 'processing');
        try {
          const outcome = await runFeedbackSmsJob({ appointmentId });
          await markReminder(job, appointmentId, type, outcome, outcome === 'sent');
        } catch (error) {
          await markReminder(job, appointmentId, type, 'failed');
          throw error;
        }
        break;
      }

      default:
        throw new Error(`Unknown reminder job type: ${type || '(missing)'}`);
    }
    },
    {
      connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
      concurrency: 5,
    }
  );
  reminderWorker.on('failed', (_job, err) => {
    console.error('Reminder worker job failed:', err?.message);
  });
  return reminderWorker;
}

async function markReminder(
  job: Job,
  appointmentId: string,
  type: string,
  status: string,
  sent = false
): Promise<void> {
  const bullJobId = job.id ? String(job.id) : undefined;
  await prisma.reminderJob.updateMany({
    where: {
      appointmentId,
      type,
      status: { not: 'cancelled' },
      ...(bullJobId ? { bullJobId } : {}),
    },
    data: {
      status,
      ...(sent ? { sentAt: new Date() } : {}),
    },
  });
}
