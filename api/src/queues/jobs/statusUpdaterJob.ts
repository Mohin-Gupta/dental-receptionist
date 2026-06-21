import { prisma } from '../../lib/prisma';

/**
 * statusUpdaterJob.ts — marks past appointments as 'completed'.
 * Split out of the monolithic reminder worker for readability — this job has
 * nothing to do with reminders/SMS/calls, it's pure DB housekeeping.
 */
export async function runStatusUpdaterJob(): Promise<void> {
  const updated = await prisma.appointment.updateMany({
    where: {
      status: { in: ['scheduled', 'confirmed'] },
      endAt: { lt: new Date() },
    },
    data: { status: 'completed' },
  });

  if (updated.count > 0) {
    console.log(`Marked ${updated.count} appointments as completed ✓`);
  }
}