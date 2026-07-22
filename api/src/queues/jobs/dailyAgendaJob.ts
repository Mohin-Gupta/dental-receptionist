import { prisma } from '../../lib/prisma';
import { sendSMS } from '../../services/twilio';

import {
  formatInTimezone,
  getTodayRangeInTimezone,
  currentHourInTz,
  currentMinuteInTz,
  currentDateInTz,
} from '../../lib/timezone';

/**
 * Sends the doctor's daily agenda at 9:00 AM
 * in the clinic's local timezone.
 *
 * Multi-tenant safe:
 * - Uses clinic timezone
 * - Sends only once per local day
 * - Handles DST automatically
 */
export async function runDailyAgendaJob(
  clinicId: string
): Promise<void> {
  const clinic =
    await prisma.clinic.findUnique({
      where: { id: clinicId },
      include: {
        doctors: { include: { doctor: true } },
        organization: { select: { status: true } },
      },
    });

  if (
    !clinic ||
    clinic.status !== 'active' ||
    !['active', 'past_due_grace'].includes(clinic.organization.status)
  ) return;

  const timezone =
    clinic.timezone ??
    'Asia/Kolkata';

  const currentHour =
    currentHourInTz(timezone);

  const currentMinute =
    currentMinuteInTz(timezone);

  const today =
    currentDateInTz(timezone);

  // Already sent today's agenda
  if (
    clinic.lastAgendaSentDate ===
    today
  ) {
    return;
  }

  // Only send around 9:00 AM local clinic time
  if (
    currentHour !== 9 ||
    currentMinute > 1
  ) {
    return;
  }

  const {
    todayStart,
    todayEnd,
  } = getTodayRangeInTimezone(
    timezone
  );

  const doctors = clinic.doctors.map((entry) => entry.doctor).filter((doctor) => doctor.status === 'active');
  if (doctors.length === 0) {
    return;
  }

  for (const doctor of doctors) {
    if (!doctor.phone) continue;

    const appointments =
      await prisma.appointment.findMany({
        where: {
          clinicId,
          doctorId: doctor.id,
          status: {
            in: [
              'scheduled',
              'confirmed',
            ],
          },
          startAt: {
            gte: todayStart,
            lt: todayEnd,
          },
        },
        select: { startAt: true },
        orderBy: {
          startAt: 'asc',
        },
      });

    if (appointments.length === 0) {
      await sendSMS(
        {
          organizationId: clinic.organizationId,
          clinicId: clinic.id,
          idempotencyKey: `clinic:${clinic.id}:agenda:${today}:doctor:${doctor.id}:sms:v1`,
          purpose: 'daily_agenda',
          defaultCallingCode: clinic.defaultCallingCode,
        },
        doctor.phone,
        `Good morning ${doctor.name}. No appointments scheduled for today at ${clinic.name}. Have a great day! Reply STOP to opt out.`
      );
      continue;
    }

    // Keep patient names and visit reasons out of ordinary SMS. The secure
    // dashboard remains the source for patient-level agenda details.
    const agendaTimes =
      appointments
        .map((appointment) => {
        const {
          readableTime,
        } = formatInTimezone(
          appointment.startAt,
          timezone
        );

        return readableTime;
        })
        .join(', ');

    await sendSMS(
      {
        organizationId: clinic.organizationId,
        clinicId: clinic.id,
        idempotencyKey: `clinic:${clinic.id}:agenda:${today}:doctor:${doctor.id}:sms:v1`,
        purpose: 'daily_agenda',
        defaultCallingCode: clinic.defaultCallingCode,
      },
      doctor.phone,
      `Good morning ${doctor.name}. You have ${appointments.length} appointment${
        appointments.length > 1
          ? 's'
          : ''
      } today at ${clinic.name}, at: ${agendaTimes}. Sign in to the secure dashboard for patient details. Reply STOP to opt out.`
    );
  }

  await prisma.clinic.update({
    where: {
      id: clinicId,
    },
    data: {
      lastAgendaSentDate: today,
    },
  });
}
