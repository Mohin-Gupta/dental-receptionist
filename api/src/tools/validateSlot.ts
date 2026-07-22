import { getAvailableSlots } from '../services/googleCalendar';
import { getSlotState, setSlotState } from './state';
import { normalizeTime, toReadableTime } from './helpers';
import { prisma } from '../lib/prisma';
import { resolveDoctorForClinic } from '../services/doctors';

interface ValidateSlotParameters {
  date: string;
  time: string;
  doctorId?: string | null;
}

export async function validateSlot(
  clinicId: string,
  callId: string,
  parameters: ValidateSlotParameters
): Promise<string> {
  const { date, time } = parameters;
  const normalized = normalizeTime(time);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const doctor = await resolveDoctorForClinic(clinic.organizationId, clinicId, parameters.doctorId);

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
  const [h, m] = normalized.split(':').map(Number);
  const readableTime = toReadableTime(h, m);

  if (isAvailable) {
    return `${readableTime} is available. Confirm with patient then proceed. Use time="${normalized}" for booking.`;
  }

  const requestedMins = h * 60 + m;
  const nearby = allSlots
    .map(s => {
      const [sh, sm] = s.start.split(':').map(Number);
      return { ...s, diff: Math.abs(sh * 60 + sm - requestedMins) };
    })
    .filter(s => s.diff > 0 && s.diff <= 90)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 2);

  const suggestions = nearby.length > 0
    ? nearby.map(s => s.label).join(' or ')
    : allSlots.slice(0, 2).map(s => s.label).join(' or ');

  return `${readableTime} is not available. Nearest: ${suggestions}. Ask which works.`;
}
