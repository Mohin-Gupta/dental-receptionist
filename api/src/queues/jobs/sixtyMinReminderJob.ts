import { prisma } from '../../lib/prisma';
import { sendSMS } from '../../services/twilio';
import { placeBolnaOutboundCall } from '../../services/bolnaOutbound';
import { formatInTimezone, isWithinHours } from '../../lib/timezone';

interface SixtyMinReminderJobData {
  appointmentId: string;
}

export async function runSixtyMinReminderJob(
  data: SixtyMinReminderJobData
): Promise<'sent' | 'skipped'> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: data.appointmentId },
    include: { clinic: true, patient: true },
  });

  if (!appointment || !['scheduled', 'confirmed'].includes(appointment.status)) {
    return 'skipped';
  }

  const timezone = appointment.clinic.timezone;
  const { readableTime, readableDate } = formatInTimezone(appointment.startAt, timezone);
  const firstName = appointment.patient.name.trim().split(/\s+/)[0] || 'there';
  const message =
    `Hi ${firstName}, reminder from ${appointment.clinic.name}: ` +
    `your appointment is in 1 hour at ${readableTime}. ` +
    'Please call us if you need to reschedule. Reply STOP to opt out.';

  if (isWithinHours(timezone, 8, 21)) {
    try {
      // Voice reminders now dispatch through Bolna instead of Vapi. The
      // idempotency key gets a distinct `:bolna:` segment (rather than
      // reusing the old `:voice:v1` key) so this never collides with a
      // pre-existing Vapi-provider CommunicationAttempt row for the same
      // appointment from before this switch — placeBolnaOutboundCall would
      // otherwise reject the reused key as "idempotency key was reused for
      // a different operation" because the stored provider wouldn't match.
      await placeBolnaOutboundCall(
        {
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          appointmentId: appointment.id,
          patientId: appointment.patientId,
          idempotencyKey: `appointment:${appointment.id}:60min-reminder:voice:bolna:v1`,
          purpose: 'appointment_reminder',
          defaultCallingCode: appointment.clinic.defaultCallingCode,
        },
        appointment.patient.phone,
        {
          patientName: firstName,
          clinicName: appointment.clinic.name,
          appointmentTime: readableTime,
          appointmentDate: readableDate,
        }
      );
      return 'sent';
    } catch {
      // A distinct, idempotent SMS operation is the delivery fallback.
    }
  }

  await sendSMS(
    {
      organizationId: appointment.organizationId,
      clinicId: appointment.clinicId,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      idempotencyKey: `appointment:${appointment.id}:60min-reminder:sms:v1`,
      purpose: 'appointment_reminder_fallback',
      defaultCallingCode: appointment.clinic.defaultCallingCode,
    },
    appointment.patient.phone,
    message
  );

  return 'sent';
}
