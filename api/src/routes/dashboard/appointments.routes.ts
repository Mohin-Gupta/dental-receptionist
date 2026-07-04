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
import { resolveDoctorForClinic } from '../../services/doctors';
import { cancelReminders, scheduleReminders } from '../../queues/reminderQueue';
import { normalizeTime } from '../../tools/helpers';
import { sendPatientNotification } from './appointmentNotifications';
import { requirePermission } from '../../auth/middleware';
import { auditAction } from '../../auth/audit';

const router = Router();

// ── List — classified by tab (upcoming / past / cancelled) ───────────────────
router.get('/dashboard/appointments', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const { tab = 'upcoming', page = '1', limit = '20' } = req.query;
  const now = new Date();
  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  type WhereClause = {
    organizationId: string;
    clinicId: string;
    startAt?: { gte?: Date; lt?: Date };
    endAt?: { lt?: Date };
    status?: string | { in: string[] };
  };

  let where: WhereClause = { organizationId, clinicId };

  if (tab === 'upcoming') {
    where = { organizationId, clinicId, startAt: { gte: now }, status: { in: ['scheduled', 'confirmed'] } };
  } else if (tab === 'past') {
    // Classified by endAt time, not the 'completed' status flag — independent
    // of whether the hourly status-updater cron job has run yet.
    where = {
      organizationId,
      clinicId,
      endAt: { lt: now },
      status: { in: ['scheduled', 'confirmed', 'completed'] },
    };
  } else if (tab === 'cancelled') {
    where = { organizationId, clinicId, status: 'cancelled' };
  }

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: { patient: true, doctor: true, clinic: true },
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
router.get('/dashboard/appointments/:id', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const appointment = await prisma.appointment.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId, clinicId: req.auth!.clinicId },
    include: { patient: true, doctor: true, clinic: true, callLogs: true, reminderJobs: true },
  });
  if (!appointment) return res.status(404).json({ error: 'Not found' });
  res.json(appointment);
});

// ── Manual booking from dashboard ─────────────────────────────────────────────
// Mirrors tools/bookAppointment.ts exactly: find-or-create patient by phone,
// create Google Calendar event, create Appointment row, send booking
// confirmation SMS, schedule the 60-min reminder + feedback SMS jobs.
router.post('/dashboard/appointments', requirePermission('appointments:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const { patientName, patientPhone, date, time, reason, doctorId } = req.body as {
    patientName: string;
    patientPhone: string;
    date: string;
    time: string;
    reason: string;
    doctorId?: string;
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
    const doctor = await resolveDoctorForClinic(organizationId, clinicId, doctorId);

    const startAtStr  = toClinicTimeString(year, month, day, hour, min, timezone);
    const endAtStr    = addMinutesToClinicString(startAtStr, 30, timezone);
    const startAtDate = new Date(startAtStr);
    const endAtDate   = new Date(endAtStr);

    if (isNaN(startAtDate.getTime())) {
      return res.status(400).json({ error: `Invalid date/time: ${date} ${finalTime}` });
    }

    let patient = await prisma.patient.findUnique({
      where: { organizationId_phone: { organizationId, phone: cleanPhone } },
    });

    if (!patient) {
      patient = await prisma.patient.create({
        data: { organizationId, clinicId, name: patientName, phone: cleanPhone },
      });
    } else {
      await prisma.patient.update({
        where: { id: patient.id },
        data: { name: patientName },
      });
    }

    const googleEventId = await createCalendarEvent(clinicId, {
      doctorId: doctor.id,
      patientName,
      patientPhone: cleanPhone,
      reason,
      startAt: startAtStr,
      endAt: endAtStr,
    });

    const appointment = await prisma.appointment.create({
      data: {
        organizationId,
        clinicId,
        doctorId: doctor.id,
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

    await auditAction(req, 'appointment.created', {
      targetType: 'Appointment',
      targetId: appointment.id,
      metadata: { patientId: patient.id, reason },
    });

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
router.patch('/dashboard/appointments/:id/reschedule', requirePermission('appointments:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const { id } = req.params;
  const { newDate, newTime, doctorId } = req.body as { newDate: string; newTime: string; doctorId?: string };

  if (!newDate || !newTime) {
    return res.status(400).json({ error: 'newDate and newTime are required' });
  }

  const oldAppointment = await prisma.appointment.findFirst({
    where: { id, organizationId, clinicId },
    include: { patient: true, clinic: true, doctor: true },
  });

  if (!oldAppointment) return res.status(404).json({ error: 'Appointment not found' });
  if (oldAppointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot reschedule a cancelled appointment' });
  }

  const timezone = oldAppointment.clinic.timezone ?? 'Asia/Kolkata';
  const doctor = await resolveDoctorForClinic(organizationId, clinicId, doctorId ?? oldAppointment.doctorId);

  const [year, month, day] = newDate.split('-').map(Number);
  const [hour, min] = newTime.split(':').map(Number);

  const startAtStr  = toClinicTimeString(year, month, day, hour, min, timezone);
  const endAtStr    = addMinutesToClinicString(startAtStr, 30, timezone);
  const startAtDate = new Date(startAtStr);
  const endAtDate   = new Date(endAtStr);

  console.log(`Reschedule: new slot in ${timezone}:`, startAtStr);

  if (oldAppointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, oldAppointment.googleEventId, oldAppointment.doctorId);
    } catch (err) {
      console.warn('Old calendar delete failed (continuing):', err);
    }
  }

  await prisma.appointment.update({ where: { id }, data: { status: 'cancelled' } });
  await cancelReminders(id);

  const googleEventId = await createCalendarEvent(clinicId, {
    doctorId: doctor.id,
    patientName:  oldAppointment.patient.name,
    patientPhone: oldAppointment.patient.phone,
    reason:       oldAppointment.reason,
    startAt:      startAtStr,
    endAt:        endAtStr,
  });

  const newAppointment = await prisma.appointment.create({
    data: {
      organizationId,
      clinicId,
      doctorId:     doctor.id,
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

  await auditAction(req, 'appointment.rescheduled', {
    targetType: 'Appointment',
    targetId: newAppointment.id,
    metadata: { previousAppointmentId: id },
  });

  res.json({
    success: true,
    appointment: newAppointment,
    message: `Rescheduled to ${readableDate} at ${readableTime}. Patient notified via SMS.`,
  });
});

// ── Cancel from dashboard ─────────────────────────────────────────────────────
router.patch('/dashboard/appointments/:id/cancel', requirePermission('appointments:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const { id } = req.params;

  const appointment = await prisma.appointment.findFirst({
    where: { id, organizationId, clinicId },
    include: { patient: true, clinic: true, doctor: true },
  });

  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Appointment is already cancelled' });
  }

  const timezone = appointment.clinic.timezone ?? 'Asia/Kolkata';

  if (appointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, appointment.googleEventId, appointment.doctorId);
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

  await auditAction(req, 'appointment.cancelled', {
    targetType: 'Appointment',
    targetId: id,
  });

  res.json({ success: true, message: `Appointment cancelled. Patient notified via SMS.` });
});

export default router;
