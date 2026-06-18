import { prisma } from '../lib/prisma';
import { deleteCalendarEvent, createCalendarEvent } from '../services/googleCalendar';
import { toClinicTimeString, addMinutesToClinicString, formatInTimezone, getClinicTimezone } from '../lib/timezone';
import { normalizeTime, toReadableTime, toReadableDate } from './helpers';
import { cancelReminders, scheduleReminders } from '../queues/reminderQueue';

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
    return 'Missing details — need appointmentId, newDate, and newTime.';
  }

  const cleanId   = appointmentId.replace(/['"]/g, '').trim();
  const finalTime = normalizeTime(newTime);

  const [year, month, day] = newDate.split('-').map(Number);
  const [hour, min]        = finalTime.split(':').map(Number);

  console.log('Parsed:', { year, month, day, hour, min });

  // Load clinic timezone once
  const timezone = await getClinicTimezone(clinicId);

  const startAtStr  = toClinicTimeString(year, month, day, hour, min, timezone);
  const endAtStr    = addMinutesToClinicString(startAtStr, 30, timezone);
  const startAtDate = new Date(startAtStr);
  const endAtDate   = new Date(endAtStr);

  console.log(`startAtStr (${timezone}):`, startAtStr);
  console.log('startAtDate valid:', !isNaN(startAtDate.getTime()));

  if (isNaN(startAtDate.getTime())) {
    return 'Could not parse the new date or time. Please ask patient to confirm the new slot.';
  }

  const oldAppointment = await prisma.appointment.findUnique({
    where: { id: cleanId },
    include: { patient: true },
  });

  console.log('Found appointment:', oldAppointment ? 'yes' : 'no');

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
      return `Already rescheduled. Say EXACTLY: "All done, ${firstName}. Your ${oldAppointment.reason} has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Is there anything else I can help you with?" If no or bye say "Take care" and end the call.`;
    }
  }

  // Delete old calendar event
  if (oldAppointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, oldAppointment.googleEventId);
      console.log('Old calendar event deleted ✓');
    } catch (err: any) {
      console.warn('Calendar delete failed (non-fatal):', err?.message);
    }
  }

  // Cancel old appointment + reminders
  await prisma.appointment.update({ where: { id: cleanId }, data: { status: 'cancelled' } });
  await cancelReminders(cleanId);
  console.log('Old appointment cancelled ✓');

  // Create new calendar event
  let googleEventId = '';
  try {
    googleEventId = await createCalendarEvent(clinicId, {
      patientName:  oldAppointment.patient.name,
      patientPhone: oldAppointment.patient.phone,
      reason:       oldAppointment.reason,
      startAt:      startAtStr,
      endAt:        endAtStr,
    });
    console.log('New calendar event created ✓', googleEventId);
  } catch (err: any) {
    console.error('Calendar create failed:', err?.message);
  }

  // Create new appointment in DB
  const newAppointment = await prisma.appointment.create({
    data: {
      clinicId,
      patientId:    oldAppointment.patientId,
      reason:       oldAppointment.reason,
      startAt:      startAtDate,
      endAt:        endAtDate,
      status:       'scheduled',
      googleEventId,
    },
  });
  console.log('New appointment created ✓', newAppointment.id);

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  await scheduleReminders(
    newAppointment.id,
    oldAppointment.patient.phone,
    oldAppointment.patient.name,
    clinic?.name ?? 'the clinic',
    startAtDate
  );

  console.log('=== RESCHEDULE COMPLETE ===');

  const readableTime = toReadableTime(hour, min);
  const readableDate = toReadableDate(newDate);
  const firstName    = oldAppointment.patient.name.split(' ')[0];

  return `Rescheduled successfully. Say EXACTLY: "All done, ${firstName}. Your ${oldAppointment.reason} has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Is there anything else I can help you with?" If no or bye say "Take care" and end the call.`;
}