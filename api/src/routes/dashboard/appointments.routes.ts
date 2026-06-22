import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import {
  toClinicTimeString,
  addMinutesToClinicString,
  formatInTimezone,
  getClinicTimezone,
} from '../../lib/timezone';
import {
  deleteCalendarEvent,
  createCalendarEvent,
} from '../../services/googleCalendar';
import { cancelReminders, scheduleReminders } from '../../queues/reminderQueue';
import { normalizeTime } from '../../tools/helpers';
import { sendPatientNotification } from './appointmentNotifications';

const router = Router();

// ── List — classified by tab (upcoming / past / cancelled) ───────────────────
router.get('/dashboard/appointments', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { tab = 'upcoming', page = '1', limit = '20' } = req.query;
  const now = new Date();
  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  type WhereClause = {
    clinicId: string;
    startAt?: { gte?: Date; lt?: Date };
    endAt?: { lt?: Date };
    status?: string | { in: string[] };
  };

  let where: WhereClause = { clinicId };

  if (tab === 'upcoming') {
    where = { clinicId, startAt: { gte: now }, status: { in: ['scheduled', 'confirmed'] } };
  } else if (tab === 'past') {
    // Classified by endAt time, not the 'completed' status flag — independent
    // of whether the hourly status-updater cron job has run yet.
    where = {
      clinicId,
      endAt: { lt: now },
      status: { in: ['scheduled', 'confirmed', 'completed'] },
    };
  } else if (tab === 'cancelled') {
    where = { clinicId, status: 'cancelled' };
  }

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: { patient: true },
      orderBy: tab === 'upcoming' ? { startAt: 'asc' } : { startAt: 'desc' },
      skip,
      take: parseInt(limit as string),
    }),
    prisma.appointment.count({ where }),
  ]);

  const timezone = await getClinicTimezone(clinicId);

  res.json({ appointments, total, page: parseInt(page as string), tab, timezone });
});

// ── Single appointment ────────────────────────────────────────────────────────
router.get('/dashboard/appointments/:id', async (req: Request, res: Response) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { patient: true, callLogs: true, reminderJobs: true },
  });
  if (!appointment) return res.status(404).json({ error: 'Not found' });
  res.json(appointment);
});

// ── Manual booking from dashboard ─────────────────────────────────────────────
// Mirrors tools/bookAppointment.ts exactly: find-or-create patient by phone,
// create Google Calendar event, create Appointment row, send booking
// confirmation SMS, schedule the 60-min reminder + feedback SMS jobs.
router.post('/dashboard/appointments', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { patientName, patientPhone, date, time, reason } = req.body as {
    patientName: string;
    patientPhone: string;
    date: string;
    time: string;
    reason: string;
  };

  if (!patientName || !patientPhone || !date || !time || !reason) {
    return res.status(400).json({
      error: 'patientName, patientPhone, date, time, and reason are all required',
    });
  }

  try {
    const cleanPhone = patientPhone.replace(/\D/g, '');
    const finalTime = normalizeTime(time);
    const [year, month, day] = date.split('-').map(Number);
    const [hour, min] = finalTime.split(':').map(Number);

    const timezone = await getClinicTimezone(clinicId);

    const startAtStr  = toClinicTimeString(year, month, day, hour, min, timezone);
    const endAtStr    = addMinutesToClinicString(startAtStr, 30, timezone);
    const startAtDate = new Date(startAtStr);
    const endAtDate   = new Date(endAtStr);

    if (isNaN(startAtDate.getTime())) {
      return res.status(400).json({ error: `Invalid date/time: ${date} ${finalTime}` });
    }

    let patient = await prisma.patient.findUnique({
      where: { clinicId_phone: { clinicId, phone: cleanPhone } },
    });

    if (!patient) {
      patient = await prisma.patient.create({
        data: { clinicId, name: patientName, phone: cleanPhone },
      });
    } else {
      await prisma.patient.update({
        where: { id: patient.id },
        data: { name: patientName },
      });
    }

    const googleEventId = await createCalendarEvent(clinicId, {
      patientName,
      patientPhone: cleanPhone,
      reason,
      startAt: startAtStr,
      endAt: endAtStr,
    });

    const appointment = await prisma.appointment.create({
      data: {
        clinicId,
        patientId: patient.id,
        reason,
        startAt: startAtDate,
        endAt: endAtDate,
        status: 'scheduled',
        googleEventId,
      },
    });

    console.log('Manually booked from dashboard ✓', appointment.id);

    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    const clinicName = clinic?.name ?? 'the clinic';
    const { readableTime, readableDate } = formatInTimezone(startAtDate, timezone);
    const firstName = patientName.split(' ')[0];

    await sendPatientNotification(
      cleanPhone,
      `Hi ${firstName}, your appointment at ${clinicName} has been confirmed for ` +
      `${readableDate} at ${readableTime} (${reason}). ` +
      `Please call us if you need to reschedule. Do not reply to this message.`,
      'Booking confirmation'
    );

    try {
      await scheduleReminders(appointment.id, cleanPhone, patientName, clinicName, startAtDate);
      console.log('Reminders scheduled ✓ (manual booking)');
    } catch (err: any) {
      console.warn('Reminder scheduling failed (non-fatal):', err?.message);
    }

    res.json({
      success: true,
      appointment,
      message: `Booked ${patientName} for ${readableDate} at ${readableTime}. Confirmation SMS sent.`,
    });
  } catch (err: any) {
    console.error('Manual booking failed:', err?.message);
    res.status(500).json({ error: 'Failed to create appointment. Please try again.' });
  }
});

// ── Reschedule from dashboard ─────────────────────────────────────────────────
router.patch('/dashboard/appointments/:id/reschedule', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { id } = req.params;
  const { newDate, newTime } = req.body as { newDate: string; newTime: string };

  if (!newDate || !newTime) {
    return res.status(400).json({ error: 'newDate and newTime are required' });
  }

  const oldAppointment = await prisma.appointment.findUnique({
    where: { id },
    include: { patient: true, clinic: true },
  });

  if (!oldAppointment) return res.status(404).json({ error: 'Appointment not found' });
  if (oldAppointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot reschedule a cancelled appointment' });
  }

  const timezone = oldAppointment.clinic.timezone ?? 'Asia/Kolkata';

  const [year, month, day] = newDate.split('-').map(Number);
  const [hour, min] = newTime.split(':').map(Number);

  const startAtStr  = toClinicTimeString(year, month, day, hour, min, timezone);
  const endAtStr    = addMinutesToClinicString(startAtStr, 30, timezone);
  const startAtDate = new Date(startAtStr);
  const endAtDate   = new Date(endAtStr);

  console.log(`Reschedule: new slot in ${timezone}:`, startAtStr);

  if (oldAppointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, oldAppointment.googleEventId);
    } catch (err) {
      console.warn('Old calendar delete failed (continuing):', err);
    }
  }

  await prisma.appointment.update({ where: { id }, data: { status: 'cancelled' } });
  await cancelReminders(id);

  const googleEventId = await createCalendarEvent(clinicId, {
    patientName:  oldAppointment.patient.name,
    patientPhone: oldAppointment.patient.phone,
    reason:       oldAppointment.reason,
    startAt:      startAtStr,
    endAt:        endAtStr,
  });

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

  await scheduleReminders(
    newAppointment.id,
    oldAppointment.patient.phone,
    oldAppointment.patient.name,
    oldAppointment.clinic.name,
    startAtDate
  );

  const { readableTime, readableDate } = formatInTimezone(startAtDate, timezone);
  const firstName = oldAppointment.patient.name.split(' ')[0];

  await sendPatientNotification(
    oldAppointment.patient.phone,
    `Hi ${firstName}, your appointment at ${oldAppointment.clinic.name} has been rescheduled ` +
    `to ${readableDate} at ${readableTime}. ` +
    `Please call us if this does not work for you. Do not reply to this message.`,
    'Reschedule'
  );

  res.json({
    success: true,
    appointment: newAppointment,
    message: `Rescheduled to ${readableDate} at ${readableTime}. Patient notified via SMS.`,
  });
});

// ── Cancel from dashboard ─────────────────────────────────────────────────────
router.patch('/dashboard/appointments/:id/cancel', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { id } = req.params;

  const appointment = await prisma.appointment.findUnique({
    where: { id },
    include: { patient: true, clinic: true },
  });

  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Appointment is already cancelled' });
  }

  const timezone = appointment.clinic.timezone ?? 'Asia/Kolkata';

  if (appointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, appointment.googleEventId);
    } catch (err) {
      console.warn('Calendar delete failed (continuing):', err);
    }
  }

  await prisma.appointment.update({ where: { id }, data: { status: 'cancelled' } });
  await cancelReminders(id);

  const { readableTime, readableDate } = formatInTimezone(appointment.startAt, timezone);
  const firstName = appointment.patient.name.split(' ')[0];

  await sendPatientNotification(
    appointment.patient.phone,
    `Hi ${firstName}, your appointment at ${appointment.clinic.name} ` +
    `on ${readableDate} at ${readableTime} has been cancelled. ` +
    `Please call us to rebook. Do not reply to this message.`,
    'Cancellation'
  );

  res.json({ success: true, message: `Appointment cancelled. Patient notified via SMS.` });
});

export default router;