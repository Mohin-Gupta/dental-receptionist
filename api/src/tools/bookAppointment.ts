import { prisma } from '../lib/prisma';
import { formatInTimezone } from '../lib/timezone';
import {
  AppointmentCommandError,
  createAppointmentCommand,
} from '../services/appointmentCommands';
import { clearCallState, getConfirmedDetails, getPatientName } from './state';

interface BookAppointmentParameters {
  doctorId?: string | null;
}

export async function bookAppointment(
  clinicId: string,
  callId: string,
  parameters: BookAppointmentParameters
): Promise<string> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { organizationId: true, timezone: true },
  });
  if (!clinic) return 'The clinic could not be verified. Offer to have clinic staff call back.';

  const operationIdempotencyKey = `call:${callId}`;
  const fullIdempotencyKey = `voice:appointment:create:${clinic.organizationId}:${operationIdempotencyKey}`;
  const previous = await prisma.appointment.findUnique({
    where: { idempotencyKey: fullIdempotencyKey },
    include: { patient: { select: { name: true } } },
  });
  if (previous) {
    const { readableTime } = formatInTimezone(previous.startAt, clinic.timezone);
    const firstName = previous.patient.name.trim().split(/\s+/)[0] || 'there';
    return `Already booked. Say EXACTLY: "You are all set, ${firstName}. See you at ${readableTime} — we will send a reminder. Is there anything else I can help you with today?"`;
  }

  const [confirmed, storedName] = await Promise.all([
    getConfirmedDetails({ clinicId, callId }),
    getPatientName({ clinicId, callId }),
  ]);
  if (!confirmed) {
    return 'The confirmed booking details have expired or are missing. Do not book. Apologise and tell the patient a team member will call them back.';
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

    const { readableTime } = formatInTimezone(result.appointment.startAt, clinic.timezone);
    const firstName = (storedName ?? confirmed.patientName).trim().split(/\s+/)[0] || 'there';
    return `Booked. Say EXACTLY: "You are all set, ${firstName}. See you at ${readableTime} — we will send a reminder. Is there anything else I can help you with today?" If no or bye say "Take care, have a great day" and end the call.`;
  } catch (error) {
    if (error instanceof AppointmentCommandError) {
      if (error.code === 'slot_unavailable') {
        return 'That slot was just taken. Do not book it. Apologise and ask the patient to choose another available time.';
      }
      if (error.code === 'organization_inactive' || error.code === 'commercial_access') {
        return 'Automatic booking is temporarily unavailable. Apologise and offer a clinic staff callback.';
      }
      if (error.code === 'invalid_input') {
        return 'The confirmed appointment date or time is invalid. Ask the patient to choose an available future slot.';
      }
    }
    throw error;
  }
}
