import { prisma } from '../../lib/prisma';
import { sendSMS } from '../../services/twilio';
import { placeOutboundCall } from '../../services/vapiOutbound';
import { formatInTimezone, isWithinHours } from '../../lib/timezone';

interface SixtyMinReminderJobData {
  appointmentId: string;
  patientPhone: string;
  patientName: string;
  clinicName: string;
}

/**
 * sixtyMinReminderJob.ts — places (or SMS-falls-back) the 60-minute-before
 * reminder call. Split out of the monolithic reminder worker for readability.
 */
export async function runSixtyMinReminderJob(data: SixtyMinReminderJobData): Promise<void> {
  const { appointmentId, patientPhone, patientName, clinicName } = data;

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { clinic: true },
  });

  if (!appointment || appointment.status === 'cancelled') {
    console.log(`Appointment ${appointmentId} not active — skipping 60-min reminder`);
    return;
  }

  const timezone = appointment.clinic.timezone ?? 'Asia/Kolkata';
  const { readableTime, readableDate } = formatInTimezone(appointment.startAt, timezone);
  const firstName = patientName.split(' ')[0];
  const phone = patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`;

  const canCall = isWithinHours(timezone, 8, 21);
  console.log(`canCall (8am–9pm in ${timezone}): ${canCall}`);

  if (canCall) {
    try {
      await placeOutboundCall(
        phone,
        process.env.VAPI_REMINDER_ASSISTANT_ID!,
        { patientName: firstName, clinicName, appointmentTime: readableTime, appointmentDate: readableDate }
      );
      console.log('60-min reminder call placed ✓');
    } catch (err: any) {
      console.error('60-min reminder call failed — SMS fallback:', err?.message);
      await sendSMS(phone,
        `Hi ${firstName}, reminder from ${clinicName}: your appointment is in 1 hour at ${readableTime}. ` +
        `Please call us if you need to reschedule. Do not reply to this message.`
      );
    }
  } else {
    console.log('Outside call hours — sending SMS reminder');
    await sendSMS(phone,
      `Hi ${firstName}, reminder from ${clinicName}: your appointment is in 1 hour at ${readableTime}. ` +
      `Please call us if you need to reschedule. Do not reply to this message.`
    );
  }

  await prisma.reminderJob.updateMany({
    where: { appointmentId, type: '60min' },
    data: { status: 'sent', sentAt: new Date() },
  });

  console.log('60-min reminder done ✓');
}