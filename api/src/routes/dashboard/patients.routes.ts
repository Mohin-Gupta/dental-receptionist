import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requirePermission } from '../../auth/middleware';
import { z } from 'zod';
import { createRouter } from '../../lib/asyncRouter';
import { auditRequired } from '../../auth/audit';

const router = createRouter();

const patientQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/dashboard/patients', requirePermission('phi:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const parsed = patientQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid patient query' });
  const { search, page, limit } = parsed.data;

  type PatientWhere = {
    organizationId: string;
    AND?: unknown[];
    OR?: { name?: { contains: string; mode: 'insensitive' }; phone?: { contains: string } }[];
  };

  const accessScope = {
    OR: [
      { clinicId },
      { appointments: { some: { organizationId, clinicId } } },
    ],
  };
  const where = search
    ? {
        organizationId,
        AND: [
          accessScope,
          {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { phone: { contains: search } },
            ],
          },
        ],
      }
    : { organizationId, ...accessScope };

  const skip = (page - 1) * limit;

  const [patients, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      include: {
        appointments: { where: { clinicId }, orderBy: { startAt: 'desc' }, take: 1 },
        _count: { select: { appointments: { where: { organizationId, clinicId } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.patient.count({ where }),
  ]);

  await auditRequired(req, 'phi.patients_list_viewed', {
    targetType: 'Patient',
    metadata: { page, resultCount: patients.length, searchUsed: Boolean(search) },
  });
  res.json({ patients, total, page, limit });
});

export default router;
