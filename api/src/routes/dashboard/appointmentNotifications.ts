import { sendSMS } from '../../services/twilio';

/**
 * appointmentNotifications.ts — small shared helper for the patient-facing SMS
 * sent on cancel/reschedule from the admin dashboard. Extracted because the
 * exact same phone-normalization + try/catch + console.log pattern was
 * duplicated three times across the appointments routes file.
 */
export async function sendPatientNotification(
  rawPhone: string,
  message: string,
  context: string
): Promise<void> {
  const phone = rawPhone.startsWith('+') ? rawPhone : `+91${rawPhone}`;

  try {
    await sendSMS(phone, message);
    console.log(`${context} SMS sent ✓`);
  } catch (err) {
    console.warn(`${context} SMS failed (non-fatal):`, err);
  }
}