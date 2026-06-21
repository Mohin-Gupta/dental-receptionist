import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { runStatusUpdaterJob } from './jobs/statusUpdaterJob';
import { runDailyAgendaJob } from './jobs/dailyAgendaJob';
import { runSixtyMinReminderJob } from './jobs/sixtyMinReminderJob';
import { runFeedbackSmsJob } from './jobs/feedbackSmsJob';

/**
 * reminderWorker.ts — thin dispatcher only. All actual job logic lives in
 * queues/jobs/*.ts — this file's only responsibility is routing job.data.type
 * to the correct handler. Previously this was ~250 lines with every job's
 * logic inlined; now each job type is independently readable and testable.
 */
export const reminderWorker = new Worker(
  'reminders',
  async (job: Job) => {
    const { type } = job.data;

    console.log(`=== REMINDER JOB === type: ${type}`);

    switch (type) {
      case 'status-update':
        await runStatusUpdaterJob();
        break;

      case 'agenda':
        await runDailyAgendaJob(job.data.clinicId);
        break;

      case '60min':
        await runSixtyMinReminderJob(job.data);
        break;

      case 'feedback':
        await runFeedbackSmsJob(job.data);
        break;

      default:
        console.warn(`Unknown reminder job type: ${type}`);
    }

    console.log(`=== REMINDER JOB DONE === type: ${type}`);
  },
  {
    connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
    concurrency: 5,
  }
);

reminderWorker.on('completed', (job) => console.log(`Job done ✓ ${job.id}`));
reminderWorker.on('failed', (job, err) => console.error(`Job failed: ${job?.id}`, err?.message));