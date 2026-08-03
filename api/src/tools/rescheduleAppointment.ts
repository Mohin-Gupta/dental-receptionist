import { z } from 'zod';
import { prisma } from '../lib/prisma';
import {
  AppointmentCommandError,
  rescheduleAppointmentCommand,
} from '../services/appointmentCommands';
import { callerVerificationRequired, isVerifiedCallPatient } from './callerVerification';
import { fail, firstNameOf, isoDateAndTime, ok, ToolResponse } from './toolResponse';

const rescheduleAppointmentSchema = z.object({
  appointmentId: z.string().trim().uuid(),
  newDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  newTime: z.string().trim().min(1).max(20),
  doctorId: z.preprocess(
    value => (value === null || value === '' ? undefined : value),
    z.string().uuid().optional()
  ),
}).strict();

export async function rescheduleAppointment(
  clinicId: string,
  callId: string,
  parameters: unknown,
  callerNumber?: string
): Promise<ToolResponse> {
  const parsed = rescheduleAppointmentSchema.safeParse(parameters);
  if (!parsed.success) {
    return fail(
      'INVALID_INPUT',
      'The reschedule details were missing or invalid. A verified appointment, a date in YYYY-MM-DD format, and a valid time are required. Ask the patient, in their current language, to repeat the details.'
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

  if (
    !appointment ||
    appointment.organizationId !== appointment.clinic.organizationId ||
    !(await isVerifiedCallPatient(clinicId, callId, appointment.patientId))
  ) {
    return callerVerificationRequired();
  }

  const operationKey = [
    'call',
    callId,
    appointment.id,
    parsed.data.newDate,
    parsed.data.newTime,
    parsed.data.doctorId ?? appointment.doctorId,
  ].join(':');

  try {
    const result = await rescheduleAppointmentCommand({
      organizationId: appointment.organizationId,
      clinicId,
      appointmentId: appointment.id,
      newDate: parsed.data.newDate,
      newTime: parsed.data.newTime,
      doctorId: parsed.data.doctorId,
      idempotencyKey: operationKey,
      source: 'voice',
    });
    const { date, time } = isoDateAndTime(result.appointment.startAt, appointment.clinic.timezone);
    const patientFirstName = firstNameOf(appointment.patient.name);
    const code = result.duplicate ? 'ALREADY_RESCHEDULED' : 'RESCHEDULED';

    return ok(
      code,
      'Tell the patient warmly, in their current language and using their first name (data.patientFirstName), that the appointment has been moved to data.date at data.time, and that a reminder will be sent. Then ask if there is anything else you can help with. If they say no or goodbye, say a warm closing and end the call in the same turn.',
      { date, time, patientFirstName }
    );
  } catch (error) {
    if (error instanceof AppointmentCommandError) {
      if (error.code === 'slot_unavailable') {
        return fail(
          'SLOT_UNAVAILABLE',
          'That requested slot is no longer available. Ask the patient, in their current language, to choose another available time.'
        );
      }
      if (error.code === 'invalid_input') {
        return fail(
          'INVALID_DATE_TIME',
          'The new date or time could not be used. Ask the patient, in their current language, to choose another future slot.'
        );
      }
      if (error.code === 'organization_inactive' || error.code === 'commercial_access') {
        return fail(
          'RESCHEDULE_UNAVAILABLE',
          'Automatic rescheduling is temporarily unavailable. Apologise in the patient\'s current language and offer a clinic staff callback.'
        );
      }
      if (error.code === 'not_active' || error.code === 'not_found') {
        return fail(
          'CANNOT_RESCHEDULE_AUTOMATICALLY',
          'That verified appointment can no longer be rescheduled automatically. Apologise in the patient\'s current language and offer a clinic staff callback.'
        );
      }
      if (error.code === 'concurrent_change') {
        return fail(
          'CONCURRENT_CHANGE',
          'That appointment changed while this was being processed. Do not retry the change. Apologise in the patient\'s current language and offer a clinic staff callback.'
        );
      }
    }
    throw error;
  }
}
