import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { formatInTimezone } from '../lib/timezone';
import {
  AppointmentCommandError,
  rescheduleAppointmentCommand,
} from '../services/appointmentCommands';
import {
  CALLER_VERIFICATION_REQUIRED,
  isVerifiedCallPatient,
} from './callerVerification';

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
): Promise<string> {
  const parsed = rescheduleAppointmentSchema.safeParse(parameters);
  if (!parsed.success) {
    return 'Missing or invalid details. A verified appointment, date in YYYY-MM-DD format, and valid time are required.';
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
    return CALLER_VERIFICATION_REQUIRED;
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
    const { readableDate, readableTime } = formatInTimezone(
      result.appointment.startAt,
      appointment.clinic.timezone
    );
    const firstName = appointment.patient.name.trim().split(/\s+/)[0] || 'there';
    const prefix = result.duplicate ? 'Already rescheduled.' : 'Rescheduled successfully.';
    return `${prefix} Say EXACTLY: "All done, ${firstName}. Your appointment has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Is there anything else I can help you with?" If no or bye say "Take care" and end the call.`;
  } catch (error) {
    if (error instanceof AppointmentCommandError) {
      if (error.code === 'slot_unavailable') {
        return 'That requested slot is no longer available. Ask the patient to choose another available time.';
      }
      if (error.code === 'invalid_input') {
        return 'Could not use the new date or time. Ask the patient to choose another future slot.';
      }
      if (error.code === 'organization_inactive' || error.code === 'commercial_access') {
        return 'Automatic rescheduling is temporarily unavailable. Offer to have clinic staff call back.';
      }
      if (error.code === 'not_active' || error.code === 'not_found') {
        return 'That verified appointment can no longer be rescheduled automatically. Offer to have clinic staff call back.';
      }
      if (error.code === 'concurrent_change') {
        return 'That appointment changed while I was processing it. Do not retry the change; offer to have clinic staff call back.';
      }
    }
    throw error;
  }
}
