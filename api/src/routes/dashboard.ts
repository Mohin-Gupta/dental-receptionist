import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSMS } from '../services/twilio';
import {
  toClinicTimeString,
  addMinutesToClinicString,
  formatInTimezone,
  getTodayRangeInTimezone,
  getClinicTimezone,
} from '../lib/timezone';
import {
  deleteCalendarEvent,
  createCalendarEvent,
  getAvailableSlots,
} from '../services/googleCalendar';
import { cancelReminders, scheduleReminders } from '../queues/reminderQueue';
import { normalizeTime } from '../tools/helpers';

const router = Router();

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/dashboard/stats', async (_req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;

  const timezone = await getClinicTimezone(clinicId);
  const { todayStart, todayEnd } = getTodayRangeInTimezone(timezone);
  const now = new Date();

  const [
    todayAppointments,
    upcomingAppointments,
    pastAppointments,
    cancelledAppointments,
    totalPatients,
    callsToday,
    todayAppointmentsList,
  ] = await Promise.all([
    prisma.appointment.count({
      where: { clinicId, startAt: { gte: todayStart, lt: todayEnd }, status: { in: ['scheduled', 'confirmed'] } },
    }),
    prisma.appointment.count({
      where: { clinicId, startAt: { gte: now }, status: { in: ['scheduled', 'confirmed'] } },
    }),
    prisma.appointment.count({
      // Same time-based logic as the 'past' tab — not dependent on the cron job
      where: {
        clinicId,
        endAt: { lt: now },
        status: { in: ['scheduled', 'confirmed', 'completed'] },
      },
    }),
    prisma.appointment.count({
      where: { clinicId, status: 'cancelled' },
    }),
    prisma.patient.count({ where: { clinicId } }),
    prisma.callLog.count({
      where: { clinicId, createdAt: { gte: todayStart, lt: todayEnd } },
    }),
    prisma.appointment.findMany({
      where: {
        clinicId,
        startAt: { gte: todayStart, lt: todayEnd },
        status: { in: ['scheduled', 'confirmed'] },
      },
      include: { patient: true },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  res.json({
    todayAppointments,
    upcomingAppointments,
    pastAppointments,
    cancelledAppointments,
    totalPatients,
    callsToday,
    todayAppointmentsList,
    timezone,
  });
});

// ── Appointments — classified ─────────────────────────────────────────────────
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
    // Classified by endAt time, not by the 'completed' status flag — this no longer
    // depends on the hourly status-updater cron job having run. An appointment whose
    // endAt has already passed is "past" regardless of whether the background job
    // flipped its status yet. Still excludes cancelled (that has its own tab).
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

// ── Available slots for manual booking ────────────────────────────────────────
// Used by the admin "New Appointment" modal to show bookable times for a given date.
// Reuses the exact same getAvailableSlots logic Maya uses on calls — same
// business hours, same Google Calendar freebusy check, same 30-min slot grid.
router.get('/dashboard/available-slots', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { date } = req.query as { date?: string };

  if (!date) {
    return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
  }

  try {
    const slots = await getAvailableSlots(clinicId, date);
    slots.sort((a, b) => {
      const [aH, aM] = a.start.split(':').map(Number);
      const [bH, bM] = b.start.split(':').map(Number);
      return (aH * 60 + aM) - (bH * 60 + bM);
    });
    res.json({ date, slots });
  } catch (err: any) {
    console.error('Available slots fetch failed:', err?.message);
    res.status(500).json({ error: 'Failed to fetch available slots' });
  }
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

    // Find-or-create patient by phone, same as bookAppointment.ts
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

    // Booking confirmation SMS — same message format as call bookings
    try {
      const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
      const clinicName = clinic?.name ?? 'the clinic';
      const { readableTime, readableDate } = formatInTimezone(startAtDate, timezone);
      const phone = cleanPhone.startsWith('+') ? cleanPhone : `+91${cleanPhone}`;
      const firstName = patientName.split(' ')[0];

      await sendSMS(phone,
        `Hi ${firstName}, your appointment at ${clinicName} has been confirmed for ` +
        `${readableDate} at ${readableTime} (${reason}). ` +
        `Please call us if you need to reschedule. Do not reply to this message.`
      );
      console.log('Booking confirmation SMS sent ✓ (manual booking)');
    } catch (err: any) {
      console.warn('Booking confirmation SMS failed (non-fatal):', err?.message);
    }

    // 60-min reminder + feedback SMS — identical scheduling to call bookings
    try {
      const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
      await scheduleReminders(
        appointment.id,
        cleanPhone,
        patientName,
        clinic?.name ?? 'the clinic',
        startAtDate
      );
      console.log('Reminders scheduled ✓ (manual booking)');
    } catch (err: any) {
      console.warn('Reminder scheduling failed (non-fatal):', err?.message);
    }

    const { readableTime, readableDate } = formatInTimezone(startAtDate, timezone);

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

  const startAtStr = toClinicTimeString(year, month, day, hour, min, timezone);
  const endAtStr   = addMinutesToClinicString(startAtStr, 30, timezone);
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

  const phone = oldAppointment.patient.phone.startsWith('+')
    ? oldAppointment.patient.phone
    : `+91${oldAppointment.patient.phone}`;
  const firstName = oldAppointment.patient.name.split(' ')[0];
  const { readableTime, readableDate } = formatInTimezone(startAtDate, timezone);

  try {
    await sendSMS(phone,
      `Hi ${firstName}, your appointment at ${oldAppointment.clinic.name} has been rescheduled ` +
      `to ${readableDate} at ${readableTime}. ` +
      `Please call us if this does not work for you. Do not reply to this message.`
    );
    console.log('Reschedule SMS sent ✓');
  } catch (err) {
    console.warn('SMS failed (non-fatal):', err);
  }

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

  const phone = appointment.patient.phone.startsWith('+')
    ? appointment.patient.phone
    : `+91${appointment.patient.phone}`;
  const firstName = appointment.patient.name.split(' ')[0];
  const { readableTime, readableDate } = formatInTimezone(appointment.startAt, timezone);

  try {
    await sendSMS(phone,
      `Hi ${firstName}, your appointment at ${appointment.clinic.name} ` +
      `on ${readableDate} at ${readableTime} has been cancelled. ` +
      `Please call us to rebook. Do not reply to this message.`
    );
    console.log('Cancellation SMS sent ✓');
  } catch (err) {
    console.warn('SMS failed (non-fatal):', err);
  }

  res.json({ success: true, message: `Appointment cancelled. Patient notified via SMS.` });
});

// ── Patients ──────────────────────────────────────────────────────────────────
router.get('/dashboard/patients', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { search, page = '1', limit = '20' } = req.query;

  type PatientWhere = {
    clinicId: string;
    OR?: { name?: { contains: string; mode: 'insensitive' }; phone?: { contains: string } }[];
  };

  const where: PatientWhere = search
    ? {
        clinicId,
        OR: [
          { name: { contains: search as string, mode: 'insensitive' } },
          { phone: { contains: search as string } },
        ],
      }
    : { clinicId };

  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  const [patients, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      include: {
        appointments: { orderBy: { startAt: 'desc' }, take: 1 },
        _count: { select: { appointments: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit as string),
    }),
    prisma.patient.count({ where }),
  ]);

  res.json({ patients, total });
});

// ── Call logs ─────────────────────────────────────────────────────────────────
router.get('/dashboard/calls', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { page = '1', limit = '20', direction } = req.query as {
    page?: string;
    limit?: string;
    direction?: 'inbound' | 'outbound';
  };
  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  const where = direction
    ? { clinicId, direction }
    : { clinicId };

  const [calls, total] = await Promise.all([
    prisma.callLog.findMany({
      where,
      include: { patient: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit as string),
    }),
    prisma.callLog.count({ where }),
  ]);

  const timezone = await getClinicTimezone(clinicId);

  res.json({ calls, total, timezone });
});

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/dashboard/settings', async (_req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  const { googleTokens: _tokens, ...safe } = clinic as typeof clinic & { googleTokens?: string };
  res.json(safe);
});

router.patch('/dashboard/settings', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const body = req.body as {
    name?: string;
    timezone?: string;
    doctorName?: string;
    doctorPhone?: string;
    doctorQualification?: string;
    doctorYOE?: string;
    doctorSpecialty?: string;
    clinicAddress?: string;
    clinicEmail?: string;
    clinicWebsite?: string;
    clinicAbout?: string;
    clinicServices?: string[];
    businessHours?: Record<string, { open: string; close: string } | null>;
  };

  const updated = await prisma.clinic.update({
    where: { id: clinicId },
    data: {
      name:               body.name,
      timezone:           body.timezone,
      doctorName:         body.doctorName,
      doctorPhone:        body.doctorPhone,
      doctorQualification: body.doctorQualification,
      doctorYOE:          body.doctorYOE ? parseInt(body.doctorYOE) : undefined,
      doctorSpecialty:    body.doctorSpecialty,
      clinicAddress:      body.clinicAddress,
      clinicEmail:        body.clinicEmail,
      clinicWebsite:      body.clinicWebsite,
      clinicAbout:        body.clinicAbout,
      clinicServices:     body.clinicServices,
      businessHours:      body.businessHours,
    },
  });

  const { googleTokens: _tokens, ...safe } = updated as typeof updated & { googleTokens?: string };
  res.json(safe);
});

// ── Reminders ─────────────────────────────────────────────────────────────────
router.get('/dashboard/reminders', async (_req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const reminders = await prisma.reminderJob.findMany({
    where: { appointment: { clinicId } },
    include: { appointment: { include: { patient: true } } },
    orderBy: { scheduledAt: 'desc' },
    take: 50,
  });
  res.json({ reminders });
});

export default router;