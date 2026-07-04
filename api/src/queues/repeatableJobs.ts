import { reminderQueue } from './reminderQueue';
import { prisma } from '../lib/prisma';

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

  const defaultClinicId = process.env.DEFAULT_CLINIC_ID;
  const defaultOrganizationId =
    process.env.DEFAULT_ORGANIZATION_ID ??
    (defaultClinicId
      ? (await prisma.clinic.findUnique({ where: { id: defaultClinicId }, select: { organizationId: true } }))?.organizationId
      : undefined);

  await reminderQueue.add(
    'daily-agenda',
    {
      type: 'agenda',
      clinicId: defaultClinicId,
      organizationId: defaultOrganizationId,
    },
    {
      repeat: {
        every: 60 * 1000,
      },
      jobId: 'daily-agenda',
    }
  );

  console.log(
    'Daily agenda job registered ✓ runs every minute'
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
