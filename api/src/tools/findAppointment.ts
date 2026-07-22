import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { formatInTimezone } from '../lib/timezone';
import {
  CALLER_VERIFICATION_REQUIRED,
  isVerifiedCallPatient,
} from './callerVerification';

const findAppointmentSchema = z.object({
  patientName: z.string().trim().min(2).max(120),
});

/**
 * Finds an appointment only after an OTP delivered to the stored patient
 * number has been consumed for this provider-authenticated call. A name,
 * caller ID, or appointment ID is never sufficient to disclose PHI.
 */
export async function findAppointment(
  clinicId: string,
  callId: string,
  parameters: unknown,
  _callerNumber?: string
): Promise<string> {
  const parsed = findAppointmentSchema.safeParse(parameters);
  if (!parsed.success) {
    return 'Ask for the full patient name used when the appointment was booked.';
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: {
      organizationId: true,
      timezone: true,
      defaultCallingCode: true,
    },
  });

  if (!clinic) return 'The clinic could not be verified. Offer to have clinic staff call back.';
  const candidates = await prisma.patient.findMany({
    where: {
      organizationId: clinic.organizationId,
      name: { contains: parsed.data.patientName, mode: 'insensitive' },
    },
    select: { id: true },
    take: 20,
  });

  const verificationChecks = await Promise.all(
    candidates.map(patient => isVerifiedCallPatient(clinicId, callId, patient.id))
  );
  const verifiedPatientIds = candidates
    .filter((_patient, index) => verificationChecks[index])
    .map(patient => patient.id);

  // Use the same response for a wrong name and a wrong number so this tool
  // cannot be used to enumerate whether somebody is a patient at the clinic.
  if (verifiedPatientIds.length === 0) return CALLER_VERIFICATION_REQUIRED;

  const appointments = await prisma.appointment.findMany({
    where: {
      organizationId: clinic.organizationId,
      clinicId,
      patientId: { in: verifiedPatientIds },
      status: { in: ['scheduled', 'confirmed'] },
      startAt: { gte: new Date() },
    },
    orderBy: { startAt: 'asc' },
    take: 5,
  });

  if (appointments.length === 0) {
    return 'The caller is verified, but no upcoming appointment was found at this clinic.';
  }

  if (appointments.length === 1) {
    const appointment = appointments[0];
    const { readableDate, readableTime } = formatInTimezone(
      appointment.startAt,
      clinic.timezone
    );
    return `Found 1 verified appointment. appointmentId="${appointment.id}". Say: "I found a ${appointment.reason} on ${readableDate} at ${readableTime} — is that the one?" If yes, use appointmentId="${appointment.id}" for the next step.`;
  }

  const list = appointments
    .map(appointment => {
      const { readableDate, readableTime } = formatInTimezone(
        appointment.startAt,
        clinic.timezone
      );
      return `appointmentId="${appointment.id}" — ${appointment.reason} on ${readableDate} at ${readableTime}`;
    })
    .join('. ');

  return `Found ${appointments.length} verified appointments: ${list}. Ask which one and use the correct appointmentId.`;
}
