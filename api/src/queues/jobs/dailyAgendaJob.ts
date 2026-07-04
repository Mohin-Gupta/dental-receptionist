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
      },
    });

  if (!clinic) {
    console.log(
      'Clinic not found — skipping agenda'
    );
    return;
  }

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
    console.log('No active doctors assigned — skipping agenda');
    return;
  }

  for (const doctor of doctors) {
    if (!doctor.phone) {
      console.log(`No phone for ${doctor.name} — skipping agenda`);
      continue;
    }

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
        include: {
          patient: true,
        },
        orderBy: {
          startAt: 'asc',
        },
      });

    const doctorPhone =
      doctor.phone.startsWith('+')
        ? doctor.phone
        : `+91${doctor.phone}`;

    if (appointments.length === 0) {
      await sendSMS(
        doctorPhone,
        `Good morning ${doctor.name}. No appointments scheduled for today at ${clinic.name}. Have a great day! Do not reply to this message.`
      );
      continue;
    }

    const agendaList =
      appointments
        .map((a, i) => {
        const {
          readableTime,
        } = formatInTimezone(
          a.startAt,
          timezone
        );

        return `${i + 1}. ${
          a.patient.name
        } at ${readableTime} — ${
          a.reason
        }`;
        })
        .join('. ');

    await sendSMS(
      doctorPhone,
      `Good morning ${doctor.name}. Today's schedule at ${clinic.name}: ${agendaList}. Total: ${appointments.length} appointment${
        appointments.length > 1
          ? 's'
          : ''
      }. Do not reply to this message.`
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

  console.log(
    `Daily agenda processed for ${doctors.length} doctor(s)`
  );
}
