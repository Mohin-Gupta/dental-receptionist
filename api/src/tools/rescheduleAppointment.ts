import { prisma } from '../lib/prisma';
import {
  deleteCalendarEvent,
  createCalendarEvent,
  toISTString,
  addMinutesToISTString,
} from '../services/googleCalendar';
import { normalizeTime, toReadableTime, toReadableDate } from './helpers';

export async function rescheduleAppointment(
  clinicId: string,
  parameters: any
): Promise<string> {
  const { appointmentId, newDate, newTime } = parameters;

  console.log('Reschedule params:', { appointmentId, newDate, newTime });

  if (!appointmentId || !newDate || !newTime) {
    return 'Missing details — need appointmentId, newDate, and newTime.';
  }

  const finalTime = normalizeTime(newTime);
  const [year, month, day] = newDate.split('-').map(Number);
  const [hour, min] = finalTime.split(':').map(Number);

  const startAtIST = toISTString(year, month, day, hour, min);
  const endAtIST = addMinutesToISTString(startAtIST, 30);
  const startAtDate = new Date(startAtIST);
  const endAtDate = new Date(endAtIST);

  if (isNaN(startAtDate.getTime())) {
    return 'Could not parse the new date or time. Please ask patient to confirm the new slot.';
  }

  // Fetch old appointment — include cancelled ones too
  const oldAppointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true },
  });

  if (!oldAppointment) {
    return 'Appointment not found. Ask patient to confirm the details.';
  }

  // Check if already rescheduled (second call guard)
  if (oldAppointment.status === 'cancelled') {
    // Look for a new appointment created after this one for same patient
    const newAppt = await prisma.appointment.findFirst({
      where: {
        patientId: oldAppointment.patientId,
        clinicId,
        status: 'scheduled',
        startAt: { gte: new Date() },
        createdAt: { gt: oldAppointment.createdAt },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (newAppt) {
      const readableTime = toReadableTime(hour, min);
      const readableDate = toReadableDate(newDate);
      const firstName = oldAppointment.patient.name.split(' ')[0];
      console.log('Already rescheduled — returning success for second call');
      return `Already rescheduled. Say EXACTLY: "All done, ${firstName}. Your ${oldAppointment.reason} has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Is there anything else I can help you with?" If no or bye say "Take care" and end the call.`;
    }
  }

  console.log(`Rescheduling: cancel ${appointmentId}, create new slot ${newDate} ${finalTime}`);

  // Step 1: Cancel old Google Calendar event
  if (oldAppointment.googleEventId && oldAppointment.status !== 'cancelled') {
    try {
      await deleteCalendarEvent(clinicId, oldAppointment.googleEventId);
      console.log('Old calendar event deleted ✓');
    } catch (err: any) {
      console.warn('Old calendar delete failed (continuing):', err?.message);
    }
  }

  // Step 2: Mark old appointment cancelled
  if (oldAppointment.status !== 'cancelled') {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: 'cancelled' },
    });
    console.log('Old appointment cancelled ✓');
  }

  // Step 3: Create new Google Calendar event
  const googleEventId = await createCalendarEvent(clinicId, {
    patientName: oldAppointment.patient.name,
    patientPhone: oldAppointment.patient.phone,
    reason: oldAppointment.reason,
    startAt: startAtIST,
    endAt: endAtIST,
  });
  console.log('New calendar event created ✓', googleEventId);

  // Step 4: Create new appointment in DB
  const newAppointment = await prisma.appointment.create({
    data: {
      clinicId,
      patientId: oldAppointment.patientId,
      reason: oldAppointment.reason,
      startAt: startAtDate,
      endAt: endAtDate,
      status: 'scheduled',
      googleEventId,
    },
  });
  console.log('New appointment created ✓', newAppointment.id);

  const readableTime = toReadableTime(hour, min);
  const readableDate = toReadableDate(newDate);
  const firstName = oldAppointment.patient.name.split(' ')[0];

  return `Rescheduled successfully. Say EXACTLY: "All done, ${firstName}. Your ${oldAppointment.reason} has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Is there anything else I can help you with?" If no or bye say "Take care" and end the call.`;
}