import { z } from 'zod';
import { prisma } from '../lib/prisma';
import {
  AppointmentCommandError,
  cancelAppointmentCommand,
} from '../services/appointmentCommands';
import { callerVerificationRequired, isVerifiedCallPatient } from './callerVerification';
import { fail, firstNameOf, isoDateAndTime, ok, ToolResponse } from './toolResponse';

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
): Promise<ToolResponse> {
  const parsed = cancelAppointmentSchema.safeParse(parameters);
  if (!parsed.success) {
    return fail(
      'INVALID_APPOINTMENT_ID',
      'No valid appointment ID was provided. Ask the patient, in their current language, to choose a verified appointment first.'
    );
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
    return callerVerificationRequired();
  }

  const { date, time } = isoDateAndTime(appointment.startAt, appointment.clinic.timezone);
  const patientFirstName = firstNameOf(appointment.patient.name);

  try {
    const result = await cancelAppointmentCommand({
      organizationId: appointment.organizationId,
      clinicId,
      appointmentId: appointment.id,
    });
    if (result.duplicate) {
      return ok(
        'ALREADY_CANCELLED',
        'This appointment is already cancelled. Tell the patient, in their current language and using their first name (data.patientFirstName), that the appointment on data.date at data.time is already cancelled.',
        { date, time, patientFirstName }
      );
    }
    return ok(
      'CANCELLED',
      'The appointment is cancelled. Tell the patient warmly, in their current language and using their first name (data.patientFirstName), that the appointment on data.date at data.time has been cancelled, and that you hope to see them again soon. Then say a warm goodbye and end the call in the same turn.',
      { date, time, patientFirstName }
    );
  } catch (error) {
    if (error instanceof AppointmentCommandError) {
      if (error.code === 'not_active') {
        return fail(
          'CANNOT_CANCEL_AUTOMATICALLY',
          'That verified appointment can no longer be cancelled automatically. Apologise in the patient\'s current language and offer a clinic staff callback.'
        );
      }
      if (error.code === 'concurrent_change') {
        return fail(
          'CONCURRENT_CHANGE',
          'That appointment changed while this was being processed. Do not attempt another change. Apologise in the patient\'s current language and offer a clinic staff callback.'
        );
      }
    }
    throw error;
  }
}
