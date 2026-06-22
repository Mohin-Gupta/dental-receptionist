import { reminderQueue } from './reminderQueue';

/**
 * repeatableJobs.ts — registers the two cron-style repeatable jobs
 * (daily agenda, hourly status updater).
 */

export async function scheduleDailyAgenda(): Promise<void> {
  const jobs =
    await reminderQueue.getRepeatableJobs();

  console.log(
    'REPEATABLE JOBS:',
    jobs
  );

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
    {
      type: 'agenda',
      clinicId:
        process.env.DEFAULT_CLINIC_ID,
    },
    {
      repeat: {
        every: 60 * 1000,
      },
      jobId: 'daily-agenda',
    }
  );

  console.log(
    'Daily agenda job registered ✓ runs every hour'
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

  console.log(
    'Appointment status updater scheduled ✓ runs every hour'
  );
}