import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSMS } from '../services/twilio';
import {
  toISTString,
  addMinutesToISTString,
  deleteCalendarEvent,
  createCalendarEvent,
} from '../services/googleCalendar';
import { cancelReminders, scheduleReminders } from '../queues/reminderQueue';

const router = Router();

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/dashboard/stats', async (_req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStart = new Date(Date.UTC(
    nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate(), 3, 30, 0
  ));
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
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
      where: { clinicId, status: 'completed' },
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
    status?: string | { in: string[] };
  };

  let where: WhereClause = { clinicId };

  if (tab === 'upcoming') {
    where = {
      clinicId,
      startAt: { gte: now },
      status: { in: ['scheduled', 'confirmed'] },
    };
  } else if (tab === 'past') {
    where = { clinicId, status: 'completed' };
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

  res.json({ appointments, total, page: parseInt(page as string), tab });
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

// ── Reschedule from dashboard ─────────────────────────────────────────────────
router.patch('/dashboard/appointments/:id/reschedule', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { id } = req.params;
  const { newDate, newTime } = req.body as { newDate: string; newTime: string };

  console.log('Reschedule request:', { id, newDate, newTime });

  if (!newDate || !newTime) {
    return res.status(400).json({ error: 'newDate and newTime are required' });
  }

  const oldAppointment = await prisma.appointment.findUnique({
    where: { id },
    include: { patient: true, clinic: true },
  });

  if (!oldAppointment) {
    return res.status(404).json({ error: 'Appointment not found' });
  }

  if (oldAppointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot reschedule a cancelled appointment' });
  }

  const [year, month, day] = newDate.split('-').map(Number);
  const [hour, min] = newTime.split(':').map(Number);

  const startAtIST = toISTString(year, month, day, hour, min);
  const endAtIST = addMinutesToISTString(startAtIST, 30);
  const startAtDate = new Date(startAtIST);
  const endAtDate = new Date(endAtIST);

  console.log('New slot IST:', startAtIST);

  // Delete old calendar event
  if (oldAppointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, oldAppointment.googleEventId);
      console.log('Old calendar event deleted ✓');
    } catch (err) {
      console.warn('Old calendar delete failed (continuing):', err);
    }
  }

  // Cancel old appointment in DB
  await prisma.appointment.update({
    where: { id },
    data: { status: 'cancelled' },
  });

  // Create new calendar event
  const googleEventId = await createCalendarEvent(clinicId, {
    patientName: oldAppointment.patient.name,
    patientPhone: oldAppointment.patient.phone,
    reason: oldAppointment.reason,
    startAt: startAtIST,
    endAt: endAtIST,
  });

  // Create new appointment
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

  // Cancel old reminders, schedule new ones
  await cancelReminders(id);
  await scheduleReminders(
    newAppointment.id,
    oldAppointment.patient.phone,
    oldAppointment.patient.name,
    oldAppointment.clinic.name,
    startAtDate
  );

  // Notify patient
  const phone = oldAppointment.patient.phone.startsWith('+')
    ? oldAppointment.patient.phone
    : `+91${oldAppointment.patient.phone}`;
  const firstName = oldAppointment.patient.name.split(' ')[0];

  const istMs = startAtDate.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
  const readableTime = `${hour12}${minuteStr} ${period}`;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const readableDate = `${monthNames[ist.getUTCMonth()]} ${ist.getUTCDate()}`;

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

  console.log('Cancel request for appointment:', id);

  const appointment = await prisma.appointment.findUnique({
    where: { id },
    include: { patient: true, clinic: true },
  });

  if (!appointment) {
    return res.status(404).json({ error: 'Appointment not found' });
  }

  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Appointment is already cancelled' });
  }

  // Delete Google Calendar event
  if (appointment.googleEventId) {
    try {
      await deleteCalendarEvent(clinicId, appointment.googleEventId);
      console.log('Calendar event deleted ✓');
    } catch (err) {
      console.warn('Calendar delete failed (continuing):', err);
    }
  }

  // Update DB
  await prisma.appointment.update({
    where: { id },
    data: { status: 'cancelled' },
  });

  // Cancel reminders
  await cancelReminders(id);

  // Notify patient
  const phone = appointment.patient.phone.startsWith('+')
    ? appointment.patient.phone
    : `+91${appointment.patient.phone}`;
  const firstName = appointment.patient.name.split(' ')[0];

  const istMs = appointment.startAt.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
  const readableTime = `${hour12}${minuteStr} ${period}`;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const readableDate = `${monthNames[ist.getUTCMonth()]} ${ist.getUTCDate()}`;

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

  res.json({
    success: true,
    message: `Appointment cancelled. Patient notified via SMS.`,
  });
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
  const { page = '1', limit = '20' } = req.query;
  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  const [calls, total] = await Promise.all([
    prisma.callLog.findMany({
      where: { clinicId },
      include: { patient: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit as string),
    }),
    prisma.callLog.count({ where: { clinicId } }),
  ]);

  res.json({ calls, total });
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
      name: body.name,
      doctorName: body.doctorName,
      doctorPhone: body.doctorPhone,
      doctorQualification: body.doctorQualification,
      doctorYOE: body.doctorYOE ? parseInt(body.doctorYOE) : undefined,
      doctorSpecialty: body.doctorSpecialty,
      clinicAddress: body.clinicAddress,
      clinicEmail: body.clinicEmail,
      clinicWebsite: body.clinicWebsite,
      clinicAbout: body.clinicAbout,
      clinicServices: body.clinicServices,
      businessHours: body.businessHours,
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