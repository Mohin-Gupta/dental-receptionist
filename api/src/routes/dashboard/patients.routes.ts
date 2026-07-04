import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requirePermission } from '../../auth/middleware';

const router = Router();

router.get('/dashboard/patients', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const { search, page = '1', limit = '20' } = req.query;

  type PatientWhere = {
    organizationId: string;
    OR?: { name?: { contains: string; mode: 'insensitive' }; phone?: { contains: string } }[];
  };

  const where: PatientWhere = search
    ? {
        organizationId,
        OR: [
          { name: { contains: search as string, mode: 'insensitive' } },
          { phone: { contains: search as string } },
        ],
      }
    : { organizationId };

  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

  const [patients, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      include: {
        appointments: { where: { clinicId }, orderBy: { startAt: 'desc' }, take: 1 },
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

export default router;
