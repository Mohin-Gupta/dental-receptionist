import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { getTodayRangeInTimezone, getClinicTimezone } from '../../lib/timezone';
import { requirePermission } from '../../auth/middleware';

const router = Router();

router.get('/dashboard/stats', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;

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
      // Time-based, not dependent on the hourly status-updater cron job
      where: {
        clinicId,
        endAt: { lt: now },
        status: { in: ['scheduled', 'confirmed', 'completed'] },
      },
    }),
    prisma.appointment.count({
      where: { clinicId, status: 'cancelled' },
    }),
    prisma.patient.count({ where: { organizationId } }),
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

export default router;
