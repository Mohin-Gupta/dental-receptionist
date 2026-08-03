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
    include: { patient: { select: { name: true } } },
  });
  if (previous) {
    const { date, time } = isoDateAndTime(previous.startAt, clinic.timezone);
    const patientFirstName = firstNameOf(previous.patient.name);
    return ok(
      'ALREADY_BOOKED',
      'This appointment is already booked. Tell the patient warmly, in their current language and using their first name (data.patientFirstName), that they are all set and will see the doctor on data.date at data.time, and that a reminder will be sent. Then ask if there is anything else you can help with.',
      { date, time, patientFirstName }
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

    return ok(
      'BOOKED',
      'The appointment is booked. Tell the patient warmly, in their current language and using their first name (data.patientFirstName), that they are all set and will see the doctor on data.date at data.time, and that a reminder will be sent. Then ask if there is anything else you can help with. If they say no or goodbye, say a warm closing (e.g. "take care, have a great day") and end the call in the same turn.',
      { date, time, patientFirstName }
    );
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
    throw error;
  }
}
