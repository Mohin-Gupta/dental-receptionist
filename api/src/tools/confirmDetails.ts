import { confirmedDetails, nameCache } from './state';
import { toReadableTime, toReadableDate } from './helpers';

export function confirmDetails(callId: string, parameters: any, callerNumber?: string): string {
  const { date, time } = parameters;
  const reason = parameters.reason?.trim() || 'General visit';
  const patientName = nameCache[callId] ?? parameters.patientName ?? 'Patient';

  // The model is unreliable at supplying a real phone number — it has no actual
  // access to the caller's number unless told. Prefer whatever the model passed,
  // but fall back to the caller ID Vapi gave us directly from the call object.
  // This is the actual fix for "what's your number" being asked on a phone call.
  const rawPhone = (parameters.patientPhone && parameters.patientPhone.trim())
    ? parameters.patientPhone
    : callerNumber ?? '';

  const cleanPhone = rawPhone.replace(/\D/g, '');
  const last4 = cleanPhone.slice(-4);

  if (!/^\d{4}$/.test(last4)) {
    // Still nothing usable — likely a genuinely new number the patient is dictating
    // and the digits weren't fully captured. Ask once, don't loop forever.
    return 'Phone number seems incorrect or incomplete. Ask patient to say their number clearly, one more time only.';
  }

  confirmedDetails[callId] = { patientName, patientPhone: cleanPhone, date, time, reason };

  const [h, m] = time.split(':').map(Number);
  const readableTime = toReadableTime(h, m);
  const readableDate = toReadableDate(date);

  console.log(`Confirmed: ${patientName}, ***${last4}, ${reason}, ${readableDate} ${readableTime}`);
  return `Say EXACTLY: "Perfect — ${patientName}, number ending in ${last4}, ${reason} on ${readableDate} at ${readableTime}. Does that sound right?"`;
}