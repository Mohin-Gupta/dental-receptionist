import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { getClinicTimezone } from '../../lib/timezone';

const router = Router();

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

export default router;