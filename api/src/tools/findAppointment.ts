import { prisma } from '../lib/prisma';
import { utcToISTReadable } from './helpers';

export async function findAppointment(
  clinicId: string,
  parameters: any
): Promise<string> {
  const searchName = (parameters.patientName ?? '').trim();

  if (!searchName) return 'No name provided. Ask for the patient name.';

  const patients = await prisma.patient.findMany({
    where: {
      clinicId,
      name: { contains: searchName, mode: 'insensitive' },
    },
  });

  if (patients.length === 0) {
    return `No patient found named "${searchName}". Ask them to confirm the name they booked under or spell it again.`;
  }

  const appointments = await prisma.appointment.findMany({
    where: {
      clinicId,
      patientId: { in: patients.map(p => p.id) },
      status: { in: ['scheduled', 'confirmed'] },
      startAt: { gte: new Date() },
    },
    include: { patient: true },
    orderBy: { startAt: 'asc' },
    take: 5,
  });

  if (appointments.length === 0) {
    return `No upcoming appointments found for "${searchName}".`;
  }

  if (appointments.length === 1) {
    const a = appointments[0];
    const { readableDate, readableTime } = utcToISTReadable(a.startAt);
    return `Found 1 appointment. appointmentId="${a.id}". Say: "I found a ${a.reason} on ${readableDate} at ${readableTime} — is that the one?" If yes use appointmentId="${a.id}" for the next step.`;
  }

  const list = appointments.map(a => {
    const { readableDate, readableTime } = utcToISTReadable(a.startAt);
    return `appointmentId="${a.id}" — ${a.reason} on ${readableDate} at ${readableTime}`;
  }).join('. ');

  return `Found ${appointments.length} appointments: ${list}. Ask which one and use the correct appointmentId.`;
}