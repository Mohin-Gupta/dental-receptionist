import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { getClinicTimezone } from '../../lib/timezone';
import { requirePermission } from '../../auth/middleware';

const router = Router();

router.get('/dashboard/calls', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const clinicId = req.auth!.clinicId;
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

export default router;
