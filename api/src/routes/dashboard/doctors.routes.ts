import { Request, Response } from 'express';
import { z } from 'zod';
import { createRouter } from '../../lib/asyncRouter';
import { prisma } from '../../lib/prisma';
import { requirePermission } from '../../auth/middleware';
import { auditAction } from '../../auth/audit';
import { publicClinicSelect } from '../../services/publicClinic';

const router = createRouter();

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const nullableEmail = z
  .union([z.string().trim().email().max(254), z.literal(''), z.null()])
  .transform((value) => value === '' ? null : value);

const doctorCreateSchema = z.object({
  name: z.string().trim().min(1, 'Doctor name is required').max(120),
  phone: nullableText(40).optional(),
  email: nullableEmail.optional(),
  qualification: nullableText(160).optional(),
  yearsExperience: z.number().int().min(0).max(100).nullable().optional(),
  specialty: nullableText(160).optional(),
  clinicIds: z.array(z.string().uuid()).max(100).refine(
    (clinicIds) => new Set(clinicIds).size === clinicIds.length,
    'Clinic IDs must be unique'
  ).optional(),
  userId: z.string().uuid().nullable().optional(),
}).strict();

const doctorUpdateSchema = doctorCreateSchema
  .omit({ clinicIds: true })
  .partial()
  .extend({
    status: z.enum(['active', 'inactive']).optional(),
    clinicIds: z.array(z.string().uuid()).max(100).refine(
      (clinicIds) => new Set(clinicIds).size === clinicIds.length,
      'Clinic IDs must be unique'
    ).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'At least one field is required');

const doctorIdSchema = z.string().uuid();

function invalidDoctorRequest(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid doctor data' });
}

function activeOrganizationClinicIds(req: Request): Set<string> {
  const organizationId = req.auth!.organizationId;
  return new Set(
    req.auth!.clinics
      .filter((clinic) => clinic.organizationId === organizationId)
      .map((clinic) => clinic.id)
  );
}

async function userBelongsToOrganization(userId: string, organizationId: string): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      status: 'active',
      OR: [
        { organizationMemberships: { some: { organizationId } } },
        { memberships: { some: { clinic: { organizationId } } } },
      ],
    },
    select: { id: true },
  });

  return Boolean(user);
}

router.get('/dashboard/doctors', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;

  const doctors = await prisma.doctor.findMany({
    where: {
      organizationId,
      status: 'active',
      clinics: { some: { clinicId } },
    },
    include: {
      clinics: {
        where: { clinic: { organizationId } },
        include: { clinic: { select: publicClinicSelect } },
      },
    },
    orderBy: { name: 'asc' },
  });

  res.json({ doctors });
});

router.post('/dashboard/doctors', requirePermission('settings:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const activeClinicId = req.auth!.clinicId;
  const parsed = doctorCreateSchema.safeParse(req.body);
  if (!parsed.success) return invalidDoctorRequest(res, parsed.error);
  const body = parsed.data;

  const requestedClinicIds = body.clinicIds?.length ? body.clinicIds : [activeClinicId];
  const allowedClinicIds = activeOrganizationClinicIds(req);
  if (requestedClinicIds.some((clinicId) => !allowedClinicIds.has(clinicId))) {
    return res.status(403).json({ error: 'Clinic access denied' });
  }

  if (body.userId && !(await userBelongsToOrganization(body.userId, organizationId))) {
    return res.status(403).json({ error: 'User access denied' });
  }
  if (body.userId !== undefined && req.auth!.organizationRole !== 'owner') {
    return res.status(403).json({ error: 'Only an organization owner can link a doctor to a user' });
  }

  const doctor = await prisma.doctor.create({
    data: {
      organizationId,
      userId: body.userId,
      name: body.name,
      phone: body.phone,
      email: body.email,
      qualification: body.qualification,
      yearsExperience: body.yearsExperience,
      specialty: body.specialty,
      clinics: {
        create: requestedClinicIds.map((clinicId) => ({ clinicId, organizationId })),
      },
    },
    include: {
      clinics: {
        where: { clinic: { organizationId } },
        include: { clinic: { select: publicClinicSelect } },
      },
    },
  });

  await auditAction(req, 'doctor.created', {
    organizationId,
    targetType: 'Doctor',
    targetId: doctor.id,
  });

  res.status(201).json({ doctor });
});

router.patch('/dashboard/doctors/:id', requirePermission('settings:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const parsedId = doctorIdSchema.safeParse(req.params.id);
  if (!parsedId.success) return res.status(400).json({ error: 'Invalid doctor ID' });

  const parsed = doctorUpdateSchema.safeParse(req.body);
  if (!parsed.success) return invalidDoctorRequest(res, parsed.error);
  const body = parsed.data;

  const existing = await prisma.doctor.findFirst({
    where: { id: parsedId.data, organizationId },
    include: { clinics: true },
  });
  if (!existing) return res.status(404).json({ error: 'Doctor not found' });

  const allowedClinicIds = activeOrganizationClinicIds(req);
  if (!existing.clinics.some((assignment) => allowedClinicIds.has(assignment.clinicId))) {
    return res.status(404).json({ error: 'Doctor not found' });
  }
  if (
    req.auth!.organizationRole !== 'owner' &&
    existing.clinics.some((assignment) => !allowedClinicIds.has(assignment.clinicId))
  ) {
    return res.status(403).json({
      error: 'An organization owner must update a doctor shared with another clinic',
    });
  }
  if (body.clinicIds?.some((clinicId) => !allowedClinicIds.has(clinicId))) {
    return res.status(403).json({ error: 'Clinic access denied' });
  }

  if (body.userId && !(await userBelongsToOrganization(body.userId, organizationId))) {
    return res.status(403).json({ error: 'User access denied' });
  }
  if (body.userId !== undefined && req.auth!.organizationRole !== 'owner') {
    return res.status(403).json({ error: 'Only an organization owner can link a doctor to a user' });
  }

  const doctor = await prisma.$transaction(async (tx) => {
    if (body.clinicIds) {
      await tx.doctorClinic.deleteMany({ where: { doctorId: existing.id } });
      await tx.doctorClinic.createMany({
        data: body.clinicIds.map((clinicId) => ({
          doctorId: existing.id,
          clinicId,
          organizationId,
        })),
        skipDuplicates: true,
      });
    }

    return tx.doctor.update({
      where: { id: existing.id },
      data: {
        userId: body.userId,
        name: body.name,
        phone: body.phone,
        email: body.email,
        qualification: body.qualification,
        yearsExperience: body.yearsExperience,
        specialty: body.specialty,
        status: body.status,
      },
      include: {
        clinics: {
          where: { clinic: { organizationId } },
          include: { clinic: { select: publicClinicSelect } },
        },
      },
    });
  });

  await auditAction(req, 'doctor.updated', {
    organizationId,
    targetType: 'Doctor',
    targetId: doctor.id,
  });

  res.json({ doctor });
});

export default router;
