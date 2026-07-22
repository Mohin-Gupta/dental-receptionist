import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { getTodayRangeInTimezone, getClinicTimezone } from '../../lib/timezone';
import { requirePermission } from '../../auth/middleware';
import { createRouter } from '../../lib/asyncRouter';
import { auditRequired } from '../../auth/audit';

const router = createRouter();

router.get('/dashboard/stats', requirePermission('phi:read'), async (req: Request, res: Response) => {
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
      where: { organizationId, clinicId, startAt: { gte: todayStart, lt: todayEnd }, status: { in: ['scheduled', 'confirmed'] } },
    }),
    prisma.appointment.count({
      where: { organizationId, clinicId, startAt: { gte: now }, status: { in: ['scheduled', 'confirmed'] } },
    }),
    prisma.appointment.count({
      // Time-based, not dependent on the hourly status-updater cron job
      where: {
        organizationId, clinicId,
        endAt: { lt: now },
        status: { in: ['scheduled', 'confirmed', 'completed'] },
      },
    }),
    prisma.appointment.count({
      where: { organizationId, clinicId, status: 'cancelled' },
    }),
    prisma.patient.count({
      where: {
        organizationId,
        OR: [{ clinicId }, { appointments: { some: { organizationId, clinicId } } }],
      },
    }),
    prisma.callLog.count({
      where: { organizationId, clinicId, createdAt: { gte: todayStart, lt: todayEnd } },
    }),
    prisma.appointment.findMany({
      where: {
        organizationId, clinicId,
        startAt: { gte: todayStart, lt: todayEnd },
        status: { in: ['scheduled', 'confirmed'] },
      },
      include: { patient: true },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  await auditRequired(req, 'phi.dashboard_summary_viewed', {
    targetType: 'Appointment',
    metadata: { resultCount: todayAppointmentsList.length },
  });
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
