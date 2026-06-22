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
    });

  if (!clinic?.doctorPhone) {
    console.log(
      'No doctor phone — skipping agenda'
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

  const appointments =
    await prisma.appointment.findMany({
      where: {
        clinicId,
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
    clinic.doctorPhone.startsWith('+')
      ? clinic.doctorPhone
      : `+91${clinic.doctorPhone}`;

  // No appointments today
  if (
    appointments.length === 0
  ) {
    await sendSMS(
      doctorPhone,
      `Good morning Doctor. No appointments scheduled for today at ${clinic.name}. Have a great day! Do not reply to this message.`
    );

    await prisma.clinic.update({
      where: {
        id: clinicId,
      },
      data: {
        lastAgendaSentDate: today,
      },
    });

    console.log(
      'No appointments today — agenda SMS sent to doctor ✓'
    );

    return;
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
    `Good morning Doctor. Today's schedule at ${clinic.name}: ${agendaList}. Total: ${appointments.length} appointment${
      appointments.length > 1
        ? 's'
        : ''
    }. Do not reply to this message.`
  );

  await prisma.clinic.update({
    where: {
      id: clinicId,
    },
    data: {
      lastAgendaSentDate: today,
    },
  });

  console.log(
    `Daily agenda SMS sent to doctor ✓ — ${appointments.length} appointments`
  );
}