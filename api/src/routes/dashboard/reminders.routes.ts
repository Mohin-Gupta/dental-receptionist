import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requirePermission } from '../../auth/middleware';
import { createRouter } from '../../lib/asyncRouter';
import { auditRequired } from '../../auth/audit';

const router = createRouter();

router.get('/dashboard/reminders', requirePermission('phi:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const reminders = await prisma.reminderJob.findMany({
    where: { organizationId, clinicId },
    include: { appointment: { include: { patient: true, doctor: true } } },
    orderBy: { scheduledAt: 'desc' },
    take: 50,
  });
  await auditRequired(req, 'phi.reminders_list_viewed', {
    targetType: 'ReminderJob',
    metadata: { resultCount: reminders.length },
  });
  res.json({ reminders });
});

export default router;
