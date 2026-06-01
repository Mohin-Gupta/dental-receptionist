import { prisma } from '../lib/prisma';
import { deleteCalendarEvent } from '../services/googleCalendar';
import { utcToISTReadable } from './helpers';
import { cancelReminders } from '../queues/reminderQueue';

export async function cancelAppointment(
  clinicId: string,
  parameters: any
): Promise<string> {
  const { appointmentId } = parameters;

  if (!appointmentId) return 'No appointment ID provided. Ask patient to confirm which appointment.';

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true },
  });

  if (!appointment) return 'Appointment not found. Ask patient to confirm the details.';

  if (appointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, appointment.googleEventId);
    } catch (err: any) {
      console.warn('Calendar delete failed (continuing):', err?.message);
    }
  }

  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: 'cancelled' },
  });

  await cancelReminders(appointmentId);
  console.log('Reminders cancelled ✓');

  const { readableDate, readableTime } = utcToISTReadable(appointment.startAt);
  const firstName = appointment.patient.name.split(' ')[0];

  console.log(`Cancelled ✓ ${appointmentId}`);
  return `Cancelled. Say EXACTLY: "Done — your ${appointment.reason} on ${readableDate} at ${readableTime} has been cancelled, ${firstName}. Hope to see you again soon. Take care." Then end the call.`;
}