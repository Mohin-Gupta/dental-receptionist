import { Router } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// ── Dashboard overview stats ──────────────────────────────────────────────────
router.get('/dashboard/stats', async (req, res) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;

  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStart = new Date(Date.UTC(
    nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate(),
    3, 30, 0
  ));
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const [
    todayAppointments,
    upcomingAppointments,
    totalPatients,
    callsToday,
    todayAppointmentsList,
  ] = await Promise.all([
    prisma.appointment.count({
      where: { clinicId, startAt: { gte: todayStart, lt: todayEnd }, status: { in: ['scheduled', 'confirmed'] } },
    }),
    prisma.appointment.count({
      where: { clinicId, startAt: { gte: new Date() }, status: { in: ['scheduled', 'confirmed'] } },
    }),
    prisma.patient.count({ where: { clinicId } }),
    prisma.callLog.count({
      where: { clinicId, createdAt: { gte: todayStart, lt: todayEnd } },
    }),
    prisma.appointment.findMany({
      where: { clinicId, startAt: { gte: todayStart, lt: todayEnd }, status: { in: ['scheduled', 'confirmed'] } },
      include: { patient: true },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  res.json({
    todayAppointments,
    upcomingAppointments,
    totalPatients,
    callsToday,
    todayAppointmentsList,
  });
});

// ── Appointments ──────────────────────────────────────────────────────────────
router.get('/dashboard/appointments', async (req, res) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { status, from, to, page = '1', limit = '20' } = req.query;

  const where: any = { clinicId };
  if (status) where.status = status;
  if (from || to) {
    where.startAt = {};
    if (from) where.startAt.gte = new Date(from as string);
    if (to) where.startAt.lte = new Date(to as string);
  }

  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: { patient: true },
      orderBy: { startAt: 'desc' },
      skip,
      take: parseInt(limit as string),
    }),
    prisma.appointment.count({ where }),
  ]);

  res.json({ appointments, total, page: parseInt(page as string), limit: parseInt(limit as string) });
});

// ── Single appointment ────────────────────────────────────────────────────────
router.get('/dashboard/appointments/:id', async (req, res) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { patient: true, callLogs: true, reminderJobs: true },
  });
  if (!appointment) return res.status(404).json({ error: 'Not found' });
  res.json(appointment);
});

// ── Patients ──────────────────────────────────────────────────────────────────
router.get('/dashboard/patients', async (req, res) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const { search, page = '1', limit = '20' } = req.query;

  const where: any = { clinicId };
  if (search) {
    where.OR = [
      { name: { contains: search as string, mode: 'insensitive' } },
      { phone: { contains: search as string } },
    ];
  }

  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  const [patients, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      include: {
        appointments: {
          orderBy: { startAt: 'desc' },
          take: 1,
        },
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
router.get('/dashboard/calls', async (req, res) => {
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

// ── Reminder jobs ─────────────────────────────────────────────────────────────
router.get('/dashboard/reminders', async (req, res) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;

  const reminders = await prisma.reminderJob.findMany({
    where: { appointment: { clinicId } },
    include: { appointment: { include: { patient: true } } },
    orderBy: { scheduledAt: 'desc' },
    take: 50,
  });

  res.json({ reminders });
});

// ── Clinic settings ───────────────────────────────────────────────────────────
router.get('/dashboard/settings', async (req, res) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });

  // Never return tokens
  const { googleTokens, ...safe } = clinic as any;
  res.json(safe);
});

router.patch('/dashboard/settings', async (req, res) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const {
    name, doctorName, doctorPhone, doctorQualification,
    doctorYOE, doctorSpecialty, clinicAddress, clinicEmail,
    clinicWebsite, clinicAbout, clinicServices, businessHours,
  } = req.body;

  const updated = await prisma.clinic.update({
    where: { id: clinicId },
    data: {
      name, doctorName, doctorPhone, doctorQualification,
      doctorYOE: doctorYOE ? parseInt(doctorYOE) : undefined,
      doctorSpecialty, clinicAddress, clinicEmail,
      clinicWebsite, clinicAbout, clinicServices, businessHours,
    },
  });

  const { googleTokens, ...safe } = updated as any;
  res.json(safe);
});

export default router;