import { prisma } from '../../lib/prisma';
import { sendSMS } from '../../services/twilio';
import { CommunicationPreferenceError } from '../../services/communicationPreferences';

interface FeedbackSmsJobData {
  appointmentId: string;
}

export async function runFeedbackSmsJob(
  data: FeedbackSmsJobData
): Promise<'sent' | 'skipped'> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: data.appointmentId },
    include: { patient: true, clinic: true },
  });

  if (!appointment || appointment.status === 'cancelled') return 'skipped';

  const firstName = appointment.patient.name.trim().split(/\s+/)[0] || 'there';
  try {
    await sendSMS(
      {
        organizationId: appointment.organizationId,
        clinicId: appointment.clinicId,
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        idempotencyKey: `appointment:${appointment.id}:feedback:sms:v1`,
        purpose: 'appointment_feedback',
        consentPolicy: 'require_opt_in',
        defaultCallingCode: appointment.clinic.defaultCallingCode,
      },
      appointment.patient.phone,
      `Hi ${firstName}, we hope your visit to ${appointment.clinic.name} went well! ` +
        'Your satisfaction means a lot to us — feel free to call us anytime. ' +
        'Reply STOP to opt out.'
    );
  } catch (error) {
    if (error instanceof CommunicationPreferenceError) return 'skipped';
    throw error;
  }

  return 'sent';
}
