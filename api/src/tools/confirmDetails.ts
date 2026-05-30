import { confirmedDetails, nameCache } from './state';
import { toReadableTime, toReadableDate } from './helpers';

export function confirmDetails(callId: string, parameters: any): string {
  const { patientPhone, date, time } = parameters;
  const reason = parameters.reason?.trim() || 'General visit';
  const patientName = nameCache[callId] ?? parameters.patientName ?? 'Patient';
  const cleanPhone = patientPhone.replace(/\D/g, '');
  const last4 = cleanPhone.slice(-4);

  if (!/^\d{4}$/.test(last4)) {
    return 'Phone number seems incorrect. Ask patient to confirm their number.';
  }

  confirmedDetails[callId] = { patientName, patientPhone: cleanPhone, date, time, reason };

  const [h, m] = time.split(':').map(Number);
  const readableTime = toReadableTime(h, m);
  const readableDate = toReadableDate(date);

  console.log(`Confirmed: ${patientName}, ***${last4}, ${reason}, ${readableDate} ${readableTime}`);
  return `Say EXACTLY: "Perfect — ${patientName}, number ending in ${last4}, ${reason} on ${readableDate} at ${readableTime}. Does that sound right?"`;
}