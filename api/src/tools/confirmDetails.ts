import {
  getPatientName,
  setConfirmedDetails,
  TenantCallScope,
} from './state';
import { toReadableTime, toReadableDate } from './helpers';
import { prisma } from '../lib/prisma';
import { toE164 } from '../lib/phone';

interface ConfirmDetailsParameters {
  date?: unknown;
  time?: unknown;
  reason?: unknown;
  patientName?: unknown;
  patientPhone?: unknown;
}

export async function confirmDetails(
  clinicId: string,
  callId: string,
  parameters: ConfirmDetailsParameters,
  callerNumber?: string
): Promise<string> {
  const scope: TenantCallScope = { clinicId, callId };

  const { date, time } = parameters;
  if (typeof date !== 'string' || typeof time !== 'string') {
    return 'The appointment date or time is missing. Ask the patient to choose an available date and time first.';
  }

  const reason = typeof parameters.reason === 'string' && parameters.reason.trim()
    ? parameters.reason.trim()
    : 'General visit';

  let storedName: string | null;
  try {
    storedName = await getPatientName(scope);
  } catch (error) {
    console.error(
      'Unable to read call name:',
      error instanceof Error ? error.message : 'unknown Redis error'
    );
    return 'I could not safely retrieve the booking details. Apologise and tell the patient a team member will call them back.';
  }

  const suppliedName = typeof parameters.patientName === 'string'
    ? parameters.patientName.trim()
    : '';
  const patientName = storedName ?? (suppliedName || 'Patient');

  // A model-supplied phone number is conversation data, not trusted identity.
  // If provider signalling has no customer number, fail closed and arrange a
  // staff callback instead of booking or messaging an arbitrary third party.
  if (!callerNumber) {
    return 'The caller phone number could not be verified from the call. Do not book or send messages; offer a clinic callback.';
  }
  const rawPhone = callerNumber;
  let normalizedPhone = '';
  try {
    const defaultCallingCode = (await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { defaultCallingCode: true },
    }))?.defaultCallingCode ?? '91';
    normalizedPhone = toE164(rawPhone, defaultCallingCode);
  } catch {
    // Fall through to the same safe retry response below.
  }
  const cleanPhone = normalizedPhone.replace(/\D/g, '');
  const last4 = cleanPhone.slice(-4);

  if (!/^\d{7,15}$/.test(cleanPhone) || !/^\d{4}$/.test(last4)) {
    return 'A complete phone number is required. Ask the patient to say the full number clearly, one more time only.';
  }

  try {
    await setConfirmedDetails(scope, {
      patientName,
      patientPhone: normalizedPhone,
      date,
      time,
      reason,
    });
  } catch (error) {
    console.error(
      'Unable to persist confirmed call details:',
      error instanceof Error ? error.message : 'unknown Redis error'
    );
    return 'I could not safely retain the confirmed booking details. Apologise and tell the patient a team member will call them back.';
  }

  const [h, m] = time.split(':').map(Number);
  const readableTime = toReadableTime(h, m);
  const readableDate = toReadableDate(date);

  return `Say EXACTLY: "Perfect — ${patientName}, number ending in ${last4}, ${reason} on ${readableDate} at ${readableTime}. Does that sound right?"`;
}
