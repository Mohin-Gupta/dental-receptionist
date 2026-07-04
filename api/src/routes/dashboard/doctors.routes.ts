import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requirePermission } from '../../auth/middleware';
import { auditAction } from '../../auth/audit';

const router = Router();

router.get('/dashboard/doctors', requirePermission('dashboard:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;

  const doctors = await prisma.doctor.findMany({
    where: {
      organizationId,
      status: 'active',
      clinics: { some: { clinicId } },
    },
    include: { clinics: { include: { clinic: true } } },
    orderBy: { name: 'asc' },
  });

  res.json({ doctors });
});

router.post('/dashboard/doctors', requirePermission('settings:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const activeClinicId = req.auth!.clinicId;
  const body = req.body as {
    name?: string;
    phone?: string | null;
    email?: string | null;
    qualification?: string | null;
    yearsExperience?: number | null;
    specialty?: string | null;
    clinicIds?: string[];
    userId?: string | null;
  };

  if (!body.name?.trim()) {
    return res.status(400).json({ error: 'Doctor name is required' });
  }

  const requestedClinicIds = body.clinicIds?.length ? body.clinicIds : [activeClinicId];
  const allowedClinicIds = new Set(req.auth!.clinics.map((clinic) => clinic.id));
  if (requestedClinicIds.some((clinicId) => !allowedClinicIds.has(clinicId))) {
    return res.status(403).json({ error: 'Clinic access denied' });
  }

  const doctor = await prisma.doctor.create({
    data: {
      organizationId,
      userId: body.userId,
      name: body.name.trim(),
      phone: body.phone,
      email: body.email,
      qualification: body.qualification,
      yearsExperience: body.yearsExperience,
      specialty: body.specialty,
      clinics: {
        create: requestedClinicIds.map((clinicId) => ({ clinicId })),
      },
    },
    include: { clinics: { include: { clinic: true } } },
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
  const body = req.body as {
    name?: string;
    phone?: string | null;
    email?: string | null;
    qualification?: string | null;
    yearsExperience?: number | null;
    specialty?: string | null;
    status?: string;
    clinicIds?: string[];
    userId?: string | null;
  };

  const existing = await prisma.doctor.findFirst({
    where: { id: req.params.id, organizationId },
    include: { clinics: true },
  });
  if (!existing) return res.status(404).json({ error: 'Doctor not found' });

  const allowedClinicIds = new Set(req.auth!.clinics.map((clinic) => clinic.id));
  if (body.clinicIds?.some((clinicId) => !allowedClinicIds.has(clinicId))) {
    return res.status(403).json({ error: 'Clinic access denied' });
  }

  const doctor = await prisma.$transaction(async (tx) => {
    if (body.clinicIds) {
      await tx.doctorClinic.deleteMany({ where: { doctorId: existing.id } });
      await tx.doctorClinic.createMany({
        data: body.clinicIds.map((clinicId) => ({ doctorId: existing.id, clinicId })),
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
      include: { clinics: { include: { clinic: true } } },
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
