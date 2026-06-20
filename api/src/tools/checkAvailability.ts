import { getAvailableSlots } from '../services/googleCalendar';
import { getClinicTimezone, isTodayInTimezone, parseInTimezone } from '../lib/timezone';
import { slotCache } from './state';

export async function checkAvailability(
  clinicId: string,
  callId: string,
  parameters: any
): Promise<string> {
  const timezone = await getClinicTimezone(clinicId);

  // Check 7-day limit using clinic's local "today"
  const nowInTz = parseInTimezone(new Date().toISOString(), timezone);
  const requestedDate = new Date(parameters.date + 'T00:00:00Z');
  const todayDate = new Date(Date.UTC(nowInTz.year, nowInTz.month - 1, nowInTz.day));
  const diffDays = Math.floor((requestedDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays > 7) {
    // Furthest bookable date is exactly 7 days from today (inclusive) — not
    // "requested date minus 7," which made the boundary message inconsistent
    // and confusing across different requested dates (e.g. June 22 vs June 23
    // produced different, contradictory-sounding cutoff phrasing).
    const furthestBookableDate = new Date(todayDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const furthestReadable = furthestBookableDate.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });

    // Exact required phrasing — do not let the model paraphrase this, since
    // paraphrasing produced inconsistent/contradictory cutoff dates across calls.
    return `Date is more than 7 days away. Say EXACTLY: "We can only book up to ${furthestReadable}. Would you like a date on or before then, or shall I have someone call you back closer to your preferred date?"`;
  }

  const slots = await getAvailableSlots(clinicId, parameters.date);
  slots.sort((a, b) => {
    const [aH, aM] = a.start.split(':').map(Number);
    const [bH, bM] = b.start.split(':').map(Number);
    return (aH * 60 + aM) - (bH * 60 + bM);
  });

  if (slots.length === 0) {
    return `No slots on ${parameters.date}. Ask patient to choose another date.`;
  }

  slotCache[callId] = {
    date: parameters.date,
    slots: slots.map(s => ({ start: s.start, label: s.label })),
  };

  const first4   = slots.slice(0, 4).map(s => s.label).join(', ');
  const lastSlot = slots[slots.length - 1].label;
  const total    = slots.length;

  return `${total} slots on ${parameters.date}. First 4: ${first4}.${total > 4 ? ` More up to ${lastSlot}.` : ''} Read first 4 naturally. Use validateSlot for specific time requests.`;
}