import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

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