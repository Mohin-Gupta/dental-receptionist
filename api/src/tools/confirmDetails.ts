import {
  getPatientName,
  setConfirmedDetails,
  TenantCallScope,
} from './state';
import { fail, ok, ToolResponse } from './toolResponse';
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
): Promise<ToolResponse> {
  const scope: TenantCallScope = { clinicId, callId };

  const { date, time } = parameters;
  if (typeof date !== 'string' || typeof time !== 'string') {
    return fail(
      'DATE_OR_TIME_MISSING',
      'The appointment date or time is missing. Ask the patient, in their current language, to choose an available date and time first.'
    );
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
    return fail(
      'STATE_UNAVAILABLE',
      'The booking details could not be safely retrieved. Apologise to the patient in their current language and tell them a team member will call them back.'
    );
  }

  const suppliedName = typeof parameters.patientName === 'string'
    ? parameters.patientName.trim()
    : '';
  const patientName = storedName ?? (suppliedName || 'Patient');

  // A model-supplied phone number is conversation data, not trusted identity.
  // If provider signalling has no customer number, fail closed and arrange a
  // staff callback instead of booking or messaging an arbitrary third party.
  if (!callerNumber) {
    return fail(
      'CALLER_NUMBER_UNVERIFIED',
      'The caller phone number could not be verified from the call. Do not book or send messages. Apologise in the patient\'s current language and offer a clinic callback.'
    );
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
    return fail(
      'PHONE_INCOMPLETE',
      'A complete phone number could not be resolved. Ask the patient, in their current language, to say the full number clearly one more time only.'
    );
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
    return fail(
      'STATE_PERSIST_FAILED',
      'The confirmed booking details could not be safely retained. Apologise to the patient in their current language and tell them a team member will call them back.'
    );
  }

  return ok(
    'CONFIRMATION_READY',
    'Read these details back to the patient naturally in their current language, then ask them to confirm ("Does that sound right?"). Preserve every fact exactly — do not alter the name, the phone digits, the reason, the date, or the time while translating or rephrasing. Wait for explicit confirmation before calling bookAppointment.',
    { patientName, phoneLast4: last4, reason, date, time }
  );
}
