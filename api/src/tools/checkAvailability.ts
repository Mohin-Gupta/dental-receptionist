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
  let doctor;
  try {
    doctor = await resolveDoctorForClinic(clinic.organizationId, clinicId, parameters.doctorId);
  } catch {
    // A stale or invalid doctorId (e.g. carried over after the doctor's
    // clinic assignment changed mid-call) is a recoverable situation, not a
    // reason to apologise and end the call — send the assistant back to
    // findDoctors rather than falling through to a generic internal error.
    return fail(
      'DOCTOR_UNAVAILABLE',
      'The selected doctor is no longer available at this clinic. Do not end the call. Apologise briefly to the patient in their current language, call findDoctors again to get current options, and let them choose again.'
    );
  }

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

  // Buckets exist so the assistant can say "we have morning and evening
  // openings" in one short sentence instead of reading out every slot. The
  // full time list per period is still included so that once the caller
  // picks a period, the assistant can read a few real times from it without
  // another tool round-trip.
  const periodOf = (start: string): 'morning' | 'afternoon' | 'evening' => {
    const hour = Number(start.split(':')[0]);
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
  };
  const periods = {
    morning: allSlots.filter(s => periodOf(s.start) === 'morning'),
    afternoon: allSlots.filter(s => periodOf(s.start) === 'afternoon'),
    evening: allSlots.filter(s => periodOf(s.start) === 'evening'),
  };
  const periodsAvailable = (['morning', 'afternoon', 'evening'] as const).filter(
    p => periods[p].length > 0
  );

  // Asking "which period works for you?" only makes sense when there is an
  // actual choice between periods. If everything open that day fits in one
  // period, or there are only a handful of slots total, offering a period
  // choice is confusing overhead — just read the real times directly.
  const offerMode: 'direct' | 'choose_period' =
    allSlots.length <= 4 || periodsAvailable.length <= 1 ? 'direct' : 'choose_period';

  const say = offerMode === 'direct'
    ? 'There is no meaningful period choice today — either very few slots exist, or they are all in one part of the day. Do NOT ask the patient to choose a period. Instead read the actual times directly and naturally from data.allSlots (all of them if 4 or fewer; otherwise the first 3-4), in the caller\'s current language, spoken as times, and ask if one works. Never invent times not present in data.'
    : 'Do NOT read out every slot. Instead, in one short sentence, tell the patient which periods have openings — using data.periodsAvailable (a subset of morning/afternoon/evening) — and ask which suits them. Once they name a period (or ask for a specific time directly), read 3-4 real times from data.periods.<chosen period> naturally, spoken as times. If the patient asks for a specific time right away instead of a period, skip the summary and use validateSlot directly. Never invent times not present in data.';

  return ok(
    'SLOTS_AVAILABLE',
    say,
    {
      date: parameters.date,
      totalSlots: allSlots.length,
      offerMode,
      periods,
      periodsAvailable,
      firstFour,
      hasMore: allSlots.length > 4,
      allSlots,
    }
  );
}
