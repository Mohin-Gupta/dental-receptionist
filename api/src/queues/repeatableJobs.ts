import { reminderQueue } from './reminderQueue';

/**
 * repeatableJobs.ts
 */

export async function scheduleDailyAgenda(): Promise<void> {
  const existing =
    await reminderQueue.getRepeatableJobs();

  for (const job of existing) {
    if (job.name === 'daily-agenda') {
      await reminderQueue.removeRepeatableByKey(
        job.key
      );
    }
  }

  await reminderQueue.add(
    'daily-agenda',
    { type: 'agenda' },
    {
      repeat: {
        every: 60 * 1000,
      },
      jobId: 'daily-agenda',
    }
  );
}

export async function scheduleAppointmentStatusUpdater(): Promise<void> {
  const existing =
    await reminderQueue.getRepeatableJobs();

  for (const job of existing) {
    if (
      job.name ===
      'update-appointment-status'
    ) {
      await reminderQueue.removeRepeatableByKey(
        job.key
      );
    }
  }

  await reminderQueue.add(
    'update-appointment-status',
    {
      type: 'status-update',
    },
    {
      repeat: {
        every: 60 * 60 * 1000,
      },
      jobId:
        'update-appointment-status',
    }
  );
}
