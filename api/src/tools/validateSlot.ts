import { getAvailableSlots } from '../services/googleCalendar';
import { getSlotState, setSlotState } from './state';
import { normalizeTime } from './helpers';
import { prisma } from '../lib/prisma';
import { resolveDoctorForClinic } from '../services/doctors';
import { fail, ok, ToolResponse } from './toolResponse';

interface ValidateSlotParameters {
  date: string;
  time: string;
  doctorId?: string | null;
}

export async function validateSlot(
  clinicId: string,
  callId: string,
  parameters: ValidateSlotParameters
): Promise<ToolResponse> {
  const { date, time } = parameters;
  const normalized = normalizeTime(time);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  let doctor;
  try {
    doctor = await resolveDoctorForClinic(clinic.organizationId, clinicId, parameters.doctorId);
  } catch {
    return fail(
      'DOCTOR_UNAVAILABLE',
      'The selected doctor is no longer available at this clinic. Do not end the call. Apologise briefly to the patient in their current language, call findDoctors again to get current options, and let them choose again.'
    );
  }

  let cachedSlots = null;
  try {
    cachedSlots = await getSlotState({ clinicId, callId });
  } catch (error) {
    // A live calendar lookup below is safer than trusting stale or unavailable
    // cache state.
    console.warn(
      'Availability state could not be read:',
      error instanceof Error ? error.message : 'unknown Redis error'
    );
  }

  let allSlots = cachedSlots?.slots ?? [];
  if (!cachedSlots || cachedSlots.date !== date) {
    const fetched = await getAvailableSlots(clinicId, date, doctor.id);
    fetched.sort((a, b) => {
      const [aH, aM] = a.start.split(':').map(Number);
      const [bH, bM] = b.start.split(':').map(Number);
      return (aH * 60 + aM) - (bH * 60 + bM);
    });
    allSlots = fetched.map(s => ({ start: s.start, label: s.label }));
    try {
      await setSlotState({ clinicId, callId }, { date, slots: allSlots });
    } catch (error) {
      console.warn(
        'Availability state was not cached:',
        error instanceof Error ? error.message : 'unknown Redis error'
      );
    }
  }

  const isAvailable = allSlots.some(s => s.start === normalized);

  if (isAvailable) {
    return ok(
      'SLOT_AVAILABLE',
      'This time is available. Confirm it back to the patient naturally in their current language, then proceed using time=data.time for the next step.',
      { date, time: normalized }
    );
  }

  const [h, m] = normalized.split(':').map(Number);
  const requestedMins = h * 60 + m;
  const nearby = allSlots
    .map(s => {
      const [sh, sm] = s.start.split(':').map(Number);
      return { start: s.start, diff: Math.abs(sh * 60 + sm - requestedMins) };
    })
    .filter(s => s.diff > 0 && s.diff <= 90)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 2)
    .map(s => ({ start: s.start }));

  const nearestSlots = nearby.length > 0
    ? nearby
    : allSlots.slice(0, 2).map(s => ({ start: s.start }));

  return fail(
    'SLOT_UNAVAILABLE',
    'This exact time is not available. Offer the alternatives in data.nearestSlots naturally in the patient\'s current language and ask which works. Do not invent other times.',
    { date, requestedTime: normalized, nearestSlots }
  );
}
