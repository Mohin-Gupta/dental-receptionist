import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

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

export default router;