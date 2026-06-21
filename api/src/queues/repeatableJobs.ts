import { reminderQueue } from './reminderQueue';

/**
 * repeatableJobs.ts — registers the two cron-style repeatable jobs
 * (daily agenda, hourly status updater). Extracted from reminderQueue.ts
 * since these are setup/registration concerns, not the core
 * schedule/cancel API that the rest of the app calls into.
 */

export async function scheduleDailyAgenda(): Promise<void> {
  const existing = await reminderQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'daily-agenda') {
      await reminderQueue.removeRepeatableByKey(job.key);
    }
  }
  await reminderQueue.add(
    'daily-agenda',
    { type: 'agenda', clinicId: process.env.DEFAULT_CLINIC_ID },
    {
      repeat: { pattern: '30 3 * * *' }, // 9:00 AM IST = 3:30 AM UTC
      jobId: 'daily-agenda',
    }
  );
  console.log('Daily agenda job registered ✓ fires at 9:00 AM IST');
}

export async function scheduleAppointmentStatusUpdater(): Promise<void> {
  const existing = await reminderQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'update-appointment-status') {
      await reminderQueue.removeRepeatableByKey(job.key);
    }
  }
  await reminderQueue.add(
    'update-appointment-status',
    { type: 'status-update' },
    {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'update-appointment-status',
    }
  );
  console.log('Appointment status updater scheduled ✓ runs every hour');
}