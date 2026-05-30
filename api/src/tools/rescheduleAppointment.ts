import { prisma } from '../lib/prisma';
import { updateCalendarEvent, toISTString, addMinutesToISTString } from '../services/googleCalendar';
import { normalizeTime, toReadableTime, toReadableDate } from './helpers';

export async function rescheduleAppointment(
  clinicId: string,
  parameters: any
): Promise<string> {
  const { appointmentId, newDate, newTime } = parameters;

  console.log('Reschedule params:', { appointmentId, newDate, newTime });

  if (!appointmentId || !newDate || !newTime) {
    return 'Missing required details. Need appointmentId, newDate, and newTime.';
  }

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true },
  });

  if (!appointment) return 'Appointment not found. Ask patient to confirm details.';

  const finalTime = normalizeTime(newTime);
  const [year, month, day] = newDate.split('-').map(Number);
  const [hour, min] = finalTime.split(':').map(Number);

  const startAtIST = toISTString(year, month, day, hour, min);
  const endAtIST = addMinutesToISTString(startAtIST, 30);
  const startAtDate = new Date(startAtIST);
  const endAtDate = new Date(endAtIST);

  if (isNaN(startAtDate.getTime())) {
    throw new Error(`Invalid date: ${newDate} ${finalTime}`);
  }

  if (appointment.googleEventId) {
    try {
      await updateCalendarEvent(clinicId, appointment.googleEventId, {
        startAt: startAtIST,
        endAt: endAtIST,
      });
    } catch (err: any) {
      console.warn('Calendar update failed (continuing):', err?.message);
    }
  }

  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { startAt: startAtDate, endAt: endAtDate, status: 'scheduled' },
  });

  const readableTime = toReadableTime(hour, min);
  const readableDate = toReadableDate(newDate);
  const firstName = appointment.patient.name.split(' ')[0];

  console.log(`Rescheduled ✓ ${appointmentId} → ${newDate} ${finalTime}`);
  return `Rescheduled. Say EXACTLY: "All done, ${firstName}. Your ${appointment.reason} has been moved to ${readableDate} at ${readableTime}. We will send a reminder. Take care." Then end the call.`;
}