import { prisma } from '../../lib/prisma';
import { sendSMS } from '../../services/twilio';

interface FeedbackSmsJobData {
  appointmentId: string;
  patientPhone: string;
  patientName: string;
  clinicName: string;
}

/**
 * feedbackSmsJob.ts — sends the post-appointment feedback SMS.
 * Split out of the monolithic reminder worker for readability.
 */
export async function runFeedbackSmsJob(data: FeedbackSmsJobData): Promise<void> {
  const { appointmentId, patientPhone, patientName, clinicName } = data;

  const firstName = patientName.split(' ')[0];
  const phone = patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`;

  try {
    await sendSMS(phone,
      `Hi ${firstName}, we hope your visit to ${clinicName} went well! ` +
      `Your satisfaction means a lot to us — feel free to call us anytime. ` +
      `Do not reply to this message.`
    );
    console.log(`Feedback SMS sent ✓ to ${phone}`);
  } catch (err: any) {
    console.error('Feedback SMS failed (non-fatal):', err?.message);
  }

  await prisma.reminderJob.updateMany({
    where: { appointmentId, type: 'feedback' },
    data: { status: 'sent', sentAt: new Date() },
  });

  console.log('Feedback job done ✓');
}