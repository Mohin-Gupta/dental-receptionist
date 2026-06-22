import { prisma } from '../../lib/prisma';
import { sendSMS } from '../../services/twilio';

import {
  formatInTimezone,
  getTodayRangeInTimezone,
  currentHourInTz,
  currentMinuteInTz,
} from '../../lib/timezone';

/**
 * dailyAgendaJob.ts — sends the doctor a morning SMS
 * listing today's appointments.
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

  const currentHour = currentHourInTz(timezone);
  const currentMinute = currentMinuteInTz(timezone);

  if (false) {
      console.log(
        `Skipping agenda — current time in ${timezone} is ${currentHour}:${currentMinute}`
      );
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
    clinic.doctorPhone.startsWith(
      '+'
    )
      ? clinic.doctorPhone
      : `+91${clinic.doctorPhone}`;

  if (
    appointments.length === 0
  ) {
    await sendSMS(
      doctorPhone,
      `Good morning Doctor. No appointments scheduled for today at ${clinic.name}. Have a great day! Do not reply to this message.`
    );

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

  console.log('================================');
  console.log('AGENDA SMS ABOUT TO SEND');
  console.log('Clinic:', clinic.name);
  console.log('Timezone:', timezone);
  console.log('Doctor:', doctorPhone);
  console.log('Appointments:', appointments.length);
  console.log('================================');

  await sendSMS(
    doctorPhone,
    `Good morning Doctor. Today's schedule at ${clinic.name}: ${agendaList}. Total: ${appointments.length} appointment${
      appointments.length > 1
        ? 's'
        : ''
    }. Do not reply to this message.`
  );
  
  console.log(
    'AGENDA SMS SUCCESSFULLY SENT'
  );
  console.log(
    `Daily agenda SMS sent to doctor ✓ — ${appointments.length} appointments`
  );
}