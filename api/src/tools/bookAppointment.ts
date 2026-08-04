import { prisma } from '../lib/prisma';
import {
  AppointmentCommandError,
  createAppointmentCommand,
} from '../services/appointmentCommands';
import { clearCallState, getConfirmedDetails, getPatientName } from './state';
import { fail, firstNameOf, isoDateAndTime, ok, ToolResponse } from './toolResponse';

interface BookAppointmentParameters {
  doctorId?: string | null;
}

const BOOKED_SAY =
  'The appointment is booked. The exact date, time, and reason were already read back and confirmed in the previous turn (via confirmDetails) — do NOT repeat them in full again here. Give a brief, warm confirmation using data.patientFirstName (e.g. "Perfect, Mohan — you\'re all set! We\'ll send a reminder too."). If data.doctorName is present, you may naturally mention which doctor they\'ll see; if it is not present, do not name or promise a specific doctor. Then ask if there is anything else you can help with. If they say no or goodbye, say a warm closing (e.g. "take care, have a great day") and end the call in the same turn.';

export async function bookAppointment(
  clinicId: string,
  callId: string,
  parameters: BookAppointmentParameters
): Promise<ToolResponse> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { organizationId: true, timezone: true },
  });
  if (!clinic) {
    return fail(
      'CLINIC_NOT_FOUND',
      'The clinic could not be verified. Apologise in the patient\'s current language and offer a clinic staff callback.'
    );
  }

  const operationIdempotencyKey = `call:${callId}`;
  const fullIdempotencyKey = `voice:appointment:create:${clinic.organizationId}:${operationIdempotencyKey}`;
  const previous = await prisma.appointment.findUnique({
    where: { idempotencyKey: fullIdempotencyKey },
    include: { patient: { select: { name: true } }, doctor: { select: { name: true } } },
  });
  if (previous) {
    const { date, time } = isoDateAndTime(previous.startAt, clinic.timezone);
    const patientFirstName = firstNameOf(previous.patient.name);
    return ok(
      'ALREADY_BOOKED',
      // Unlike a fresh BOOKED, this can happen without a confirmDetails just
      // spoken in this turn (e.g. a retried tool call), so date/time are
      // safe to state if useful, but keep it to one short warm sentence.
      'This appointment is already booked. Tell the patient briefly and warmly, using data.patientFirstName, that they\'re all set for data.date at data.time (mention data.doctorName only if present). Then ask if there is anything else you can help with.',
      { date, time, patientFirstName, doctorName: previous.doctor?.name ?? null }
    );
  }

  const [confirmed, storedName] = await Promise.all([
    getConfirmedDetails({ clinicId, callId }),
    getPatientName({ clinicId, callId }),
  ]);
  if (!confirmed) {
    return fail(
      'CONFIRMATION_EXPIRED',
      'The confirmed booking details have expired or are missing. Do not book. Apologise to the patient in their current language and tell them a team member will call them back.'
    );
  }

  try {
    const result = await createAppointmentCommand({
      organizationId: clinic.organizationId,
      clinicId,
      patientName: storedName ?? confirmed.patientName,
      patientPhone: confirmed.patientPhone,
      date: confirmed.date,
      time: confirmed.time,
      reason: confirmed.reason,
      doctorId: parameters.doctorId,
      idempotencyKey: operationIdempotencyKey,
      source: 'voice',
    });
    await clearCallState(clinicId, callId);

    const { date, time } = isoDateAndTime(result.appointment.startAt, clinic.timezone);
    const patientFirstName = firstNameOf(storedName ?? confirmed.patientName);
    const doctor = result.appointment.doctorId
      ? await prisma.doctor.findUnique({
          where: { id: result.appointment.doctorId },
          select: { name: true },
        })
      : null;

    return ok('BOOKED', BOOKED_SAY, {
      date,
      time,
      patientFirstName,
      doctorName: doctor?.name ?? null,
    });
  } catch (error) {
    if (error instanceof AppointmentCommandError) {
      if (error.code === 'slot_unavailable') {
        return fail(
          'SLOT_TAKEN',
          'That slot was just taken by another booking. Do not book it. Apologise to the patient in their current language and ask them to choose another available time.'
        );
      }
      if (error.code === 'organization_inactive' || error.code === 'commercial_access') {
        return fail(
          'BOOKING_UNAVAILABLE',
          'Automatic booking is temporarily unavailable. Apologise in the patient\'s current language and offer a clinic staff callback.'
        );
      }
      if (error.code === 'invalid_input') {
        return fail(
          'INVALID_DATE_TIME',
          'The confirmed appointment date or time is invalid. Ask the patient, in their current language, to choose an available future slot.'
        );
      }
    }
    // A stale/invalid doctorId throws a plain Error from resolveDoctorForClinic
    // (not an AppointmentCommandError) — treat it as recoverable rather than
    // falling through to the generic internal-error path that ends the call.
    if (error instanceof Error && /doctor/i.test(error.message)) {
      return fail(
        'DOCTOR_UNAVAILABLE',
        'The selected doctor is no longer available at this clinic. Do not end the call. Apologise briefly to the patient in their current language, call findDoctors again to get current options, and continue booking with their new choice.'
      );
    }
    throw error;
  }
}
