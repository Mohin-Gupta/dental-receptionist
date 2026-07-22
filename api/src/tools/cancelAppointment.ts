import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { formatInTimezone } from '../lib/timezone';
import {
  AppointmentCommandError,
  cancelAppointmentCommand,
} from '../services/appointmentCommands';
import {
  CALLER_VERIFICATION_REQUIRED,
  isVerifiedCallPatient,
} from './callerVerification';

const cancelAppointmentSchema = z.object({
  appointmentId: z.string().trim().uuid(),
}).strict();

/**
 * Cancels only an appointment owned by this clinic and by the verified caller.
 * The command writes the cancellation and its outbox event atomically; provider
 * cleanup and notifications are retried by the worker after this returns.
 */
export async function cancelAppointment(
  clinicId: string,
  callId: string,
  parameters: unknown,
  callerNumber?: string
): Promise<string> {
  const parsed = cancelAppointmentSchema.safeParse(parameters);
  if (!parsed.success) {
    return 'No valid appointment ID was provided. Ask the patient to choose a verified appointment first.';
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: parsed.data.appointmentId, clinicId },
    include: {
      patient: { select: { name: true, phone: true } },
      clinic: {
        select: {
          organizationId: true,
          timezone: true,
          defaultCallingCode: true,
        },
      },
    },
  });

  // Missing IDs and caller mismatches deliberately have the same response so
  // appointment identifiers cannot be used as an enumeration oracle.
  if (
    !appointment ||
    appointment.organizationId !== appointment.clinic.organizationId ||
    !(await isVerifiedCallPatient(clinicId, callId, appointment.patientId))
  ) {
    return CALLER_VERIFICATION_REQUIRED;
  }

  const { readableDate, readableTime } = formatInTimezone(
    appointment.startAt,
    appointment.clinic.timezone
  );
  const firstName = appointment.patient.name.trim().split(/\s+/)[0] || 'there';

  try {
    const result = await cancelAppointmentCommand({
      organizationId: appointment.organizationId,
      clinicId,
      appointmentId: appointment.id,
    });
    if (result.duplicate) {
      return `Already cancelled. Say: "That appointment on ${readableDate} at ${readableTime} is already cancelled, ${firstName}."`;
    }
    return `Cancelled. Say EXACTLY: "Done — your appointment on ${readableDate} at ${readableTime} has been cancelled, ${firstName}. Hope to see you again soon. Take care." Then end the call.`;
  } catch (error) {
    if (error instanceof AppointmentCommandError) {
      if (error.code === 'not_active') {
        return 'That verified appointment can no longer be cancelled automatically. Offer to have clinic staff call back.';
      }
      if (error.code === 'concurrent_change') {
        return 'That appointment changed while I was processing it. Do not make another change; offer to have clinic staff call back.';
      }
    }
    throw error;
  }
}
