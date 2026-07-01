import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requirePermission } from '../../auth/middleware';

const router = Router();

router.get('/dashboard/reminders', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const clinicId = req.auth!.clinicId;
  const reminders = await prisma.reminderJob.findMany({
    where: { appointment: { clinicId } },
    include: { appointment: { include: { patient: true } } },
    orderBy: { scheduledAt: 'desc' },
    take: 50,
  });
  res.json({ reminders });
});

export default router;
