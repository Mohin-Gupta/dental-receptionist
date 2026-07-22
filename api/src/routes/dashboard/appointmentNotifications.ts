import { sendSMS } from '../../services/twilio';

export interface PatientNotificationContext {
  organizationId: string;
  clinicId: string;
  appointmentId: string;
  patientId: string;
  idempotencyKey: string;
  purpose: string;
  defaultCallingCode?: string;
}

/**
 * Best-effort dashboard notification. The underlying provider attempt remains
 * durable and accurately records failure; this helper returns false so callers
 * do not claim to the operator that a message was sent.
 */
export async function sendPatientNotification(
  context: PatientNotificationContext,
  rawPhone: string,
  message: string
): Promise<boolean> {
  try {
    await sendSMS(context, rawPhone, message);
    return true;
  } catch {
    return false;
  }
}
