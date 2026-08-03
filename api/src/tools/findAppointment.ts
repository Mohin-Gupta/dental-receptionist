import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { isoDateAndTime, ok, fail, ToolResponse } from './toolResponse';
import { callerVerificationRequired, isVerifiedCallPatient } from './callerVerification';

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
): Promise<ToolResponse> {
  const parsed = findAppointmentSchema.safeParse(parameters);
  if (!parsed.success) {
    return fail(
      'NAME_REQUIRED',
      'Ask the patient, in their current language, for the full name used when the appointment was booked.'
    );
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: {
      organizationId: true,
      timezone: true,
      defaultCallingCode: true,
    },
  });

  if (!clinic) {
    return fail(
      'CLINIC_NOT_FOUND',
      'The clinic could not be verified. Apologise in the patient\'s current language and offer a clinic staff callback.'
    );
  }
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
  if (verifiedPatientIds.length === 0) return callerVerificationRequired();

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
    return fail(
      'NO_APPOINTMENT_FOUND',
      'The caller is verified, but no upcoming appointment was found at this clinic. Tell the patient this, in their current language, and ask how you can help.'
    );
  }

  const appointmentList = appointments.map(appointment => {
    const { date, time } = isoDateAndTime(appointment.startAt, clinic.timezone);
    return {
      appointmentId: appointment.id,
      reason: appointment.reason,
      date,
      time,
    };
  });

  if (appointmentList.length === 1) {
    return ok(
      'APPOINTMENT_FOUND',
      'Describe this appointment (data.appointments[0]) naturally in the patient\'s current language and ask "is that the one?". If confirmed, use appointmentId=data.appointments[0].appointmentId for the next step.',
      { count: 1, appointments: appointmentList }
    );
  }

  return ok(
    'APPOINTMENTS_FOUND',
    'List data.appointments naturally in the patient\'s current language, ask which one they mean, and use the matching appointmentId for the next step.',
    { count: appointmentList.length, appointments: appointmentList }
  );
}
