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

  console.log('=== RESCHEDULE START ===');
  console.log('appointmentId:', appointmentId);
  console.log('newDate:', newDate);
  console.log('newTime:', newTime);

  if (!appointmentId || !newDate || !newTime) {
    console.error('Missing params:', { appointmentId, newDate, newTime });
    return 'Missing details — need appointmentId, newDate, and newTime.';
  }

  // Clean appointmentId — remove quotes if LLM wrapped it
  const cleanId = appointmentId.replace(/['"]/g, '').trim();
  console.log('cleanId:', cleanId);

  const finalTime = normalizeTime(newTime);
  console.log('finalTime:', finalTime);

  const dateParts = newDate.split('-').map(Number);
  const year = dateParts[0];
  const month = dateParts[1];
  const day = dateParts[2];
  const timeParts = finalTime.split(':').map(Number);
  const hour = timeParts[0];
  const min = timeParts[1];

  console.log('Parsed:', { year, month, day, hour, min });

  const startAtIST = toISTString(year, month, day, hour, min);
  const endAtIST = addMinutesToISTString(startAtIST, 30);
  const startAtDate = new Date(startAtIST);
  const endAtDate = new Date(endAtIST);

  console.log('startAtIST:', startAtIST);
  console.log('startAtDate valid:', !isNaN(startAtDate.getTime()));

  if (isNaN(startAtDate.getTime())) {
    return 'Could not parse the new date or time. Please ask patient to confirm the new slot.';
  }

  // Fetch old appointment
  console.log('Fetching appointment:', cleanId);
  const oldAppointment = await prisma.appointment.findUnique({
    where: { id: cleanId },
    include: { patient: true },
  });

  console.log('Found appointment:', oldAppointment ? 'yes' : 'no');
  if (oldAppointment) {
    console.log('Status:', oldAppointment.status);
    console.log('Patient:', oldAppointment.patient.name);
    console.log('googleEventId:', oldAppointment.googleEventId);
  }

  if (!oldAppointment) {
    return `Appointment not found for ID: ${cleanId}. Ask patient to confirm the details.`;
  }

  // Already cancelled guard
  if (oldAppointment.status === 'cancelled') {
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
      console.log('Already rescheduled — idempotent response');
      return `Already rescheduled. Say EXACTLY: "All done, ${firstName}. Your ${oldAppointment.reason} has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Is there anything else I can help you with?" If no or bye say "Take care" and end the call.`;
    }
  }

  // Step 1: Delete old calendar event
  if (oldAppointment.googleEventId) {
    try {
      console.log('Deleting old calendar event:', oldAppointment.googleEventId);
      await deleteCalendarEvent(clinicId, oldAppointment.googleEventId);
      console.log('Old calendar event deleted ✓');
    } catch (err: any) {
      console.warn('Calendar delete failed (non-fatal):', err?.message);
    }
  } else {
    console.log('No googleEventId — skipping calendar delete');
  }

  // Step 2: Cancel old appointment in DB
  console.log('Cancelling old appointment in DB...');
  await prisma.appointment.update({
    where: { id: cleanId },
    data: { status: 'cancelled' },
  });
  console.log('Old appointment cancelled ✓');

  // Step 3: Create new calendar event
  console.log('Creating new calendar event...');
  let googleEventId = '';
  try {
    googleEventId = await createCalendarEvent(clinicId, {
      patientName: oldAppointment.patient.name,
      patientPhone: oldAppointment.patient.phone,
      reason: oldAppointment.reason,
      startAt: startAtIST,
      endAt: endAtIST,
    });
    console.log('New calendar event created ✓', googleEventId);
  } catch (err: any) {
    console.error('Calendar create failed:', err?.message);
    // Continue even if calendar fails — DB is source of truth
  }

  // Step 4: Create new appointment in DB
  console.log('Creating new appointment in DB...');
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
  console.log('=== RESCHEDULE COMPLETE ===');

  const readableTime = toReadableTime(hour, min);
  const readableDate = toReadableDate(newDate);
  const firstName = oldAppointment.patient.name.split(' ')[0];

  return `Rescheduled successfully. Say EXACTLY: "All done, ${firstName}. Your ${oldAppointment.reason} has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Is there anything else I can help you with?" If no or bye say "Take care" and end the call.`;
}