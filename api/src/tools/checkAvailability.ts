import { getAvailableSlots } from '../services/googleCalendar';
import { getClinicTimezone, parseInTimezone } from '../lib/timezone';
import { setSlotState } from './state';
import { prisma } from '../lib/prisma';
import { resolveDoctorForClinic } from '../services/doctors';
import { fail, ok, ToolResponse } from './toolResponse';

interface CheckAvailabilityParameters {
  date: string;
  doctorId?: string | null;
}

export async function checkAvailability(
  clinicId: string,
  callId: string,
  parameters: CheckAvailabilityParameters
): Promise<ToolResponse> {
  const timezone = await getClinicTimezone(clinicId);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const doctor = await resolveDoctorForClinic(clinic.organizationId, clinicId, parameters.doctorId);

  // Check 7-day limit using clinic's local "today"
  const nowInTz = parseInTimezone(new Date().toISOString(), timezone);
  const requestedDate = new Date(parameters.date + 'T00:00:00Z');
  const todayDate = new Date(Date.UTC(nowInTz.year, nowInTz.month - 1, nowInTz.day));
  const diffDays = Math.floor((requestedDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays > 7) {
    // Furthest bookable date is exactly 7 days from today (inclusive) — not
    // "requested date minus 7," which made the boundary message inconsistent
    // across different requested dates. This is now a plain ISO date in
    // `data`, not a pre-written English sentence, so the assistant can speak
    // it naturally in whatever language the caller is using.
    const furthestBookableDate = new Date(todayDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    const furthestIso = `${furthestBookableDate.getUTCFullYear()}-${pad(furthestBookableDate.getUTCMonth() + 1)}-${pad(furthestBookableDate.getUTCDate())}`;

    return fail(
      'BOOKING_WINDOW_EXCEEDED',
      'The requested date is beyond the 7-day booking window. Tell the patient, in their current language, that appointments can only be booked up to data.furthestBookableDate (a date, not a number of days), and ask whether they would like a date on or before then, or a callback closer to their preferred date. Do not invent a different cutoff and do not paraphrase this into a different date.',
      { requestedDate: parameters.date, furthestBookableDate: furthestIso }
    );
  }

  const slots = await getAvailableSlots(clinicId, parameters.date, doctor.id);
  slots.sort((a, b) => {
    const [aH, aM] = a.start.split(':').map(Number);
    const [bH, bM] = b.start.split(':').map(Number);
    return (aH * 60 + aM) - (bH * 60 + bM);
  });

  if (slots.length === 0) {
    // No slots is a fact, not an explanation. Never let the model guess why
    // — it does not know whether it's a holiday, a closure, or fully booked.
    return fail(
      'NO_SLOTS_AVAILABLE',
      'There are no openings on data.date. Tell the patient this in their current language and ask if another date would work. Do not say or imply the clinic is closed — you only know that there are no open slots, not why.',
      { date: parameters.date }
    );
  }

  try {
    await setSlotState(
      { clinicId, callId },
      {
        date: parameters.date,
        slots: slots.map(s => ({ start: s.start, label: s.label })),
      }
    );
  } catch (error) {
    // Availability is still safe to present. validateSlot will query the source
    // of truth again if Redis is unavailable or the state was not cached.
    console.warn(
      'Availability state was not cached:',
      error instanceof Error ? error.message : 'unknown Redis error'
    );
  }

  const allSlots = slots.map(s => ({ start: s.start }));
  const firstFour = allSlots.slice(0, 4);

  return ok(
    'SLOTS_AVAILABLE',
    'Read the first 4 times in data.firstFour naturally to the patient in their current language (speak them as times, do not read raw 24-hour digits literally). If data.hasMore is true, mention more times are available later in the day without listing them yet. Wait for the patient to choose, then use validateSlot to confirm a specific time before proceeding.',
    {
      date: parameters.date,
      totalSlots: allSlots.length,
      firstFour,
      hasMore: allSlots.length > 4,
      allSlots,
    }
  );
}
