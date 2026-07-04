import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { auditAction } from '../../auth/audit';
import { requirePermission } from '../../auth/middleware';

const router = Router();

router.get('/dashboard/settings', requirePermission('settings:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const [organization, clinic, doctors] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId } }),
    prisma.clinic.findUnique({ where: { id: clinicId } }),
    prisma.doctor.findMany({
      where: { organizationId, clinics: { some: { clinicId } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  const { googleTokens: _tokens, ...safe } = clinic as typeof clinic & { googleTokens?: string };
  res.json({ organization, clinic: safe, doctors });
});

router.patch('/dashboard/settings', requirePermission('settings:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const body = req.body as {
    organization?: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      website?: string | null;
      about?: string | null;
      services?: string[] | null;
      planTier?: string;
    };
    clinic?: {
      name?: string;
      phone?: string;
      timezone?: string;
      googleCalendarId?: string | null;
      clinicAddress?: string | null;
      clinicEmail?: string | null;
      clinicWebsite?: string | null;
      clinicAbout?: string | null;
      clinicServices?: string[] | null;
      businessHours?: Record<string, { open: string; close: string } | null>;
    };
    name?: string;
    phone?: string;
    timezone?: string;
    googleCalendarId?: string | null;
    clinicAddress?: string;
    clinicEmail?: string;
    clinicWebsite?: string;
    clinicAbout?: string;
    clinicServices?: string[];
    businessHours?: Record<string, { open: string; close: string } | null>;
  };

  const organizationBody = body.organization;
  const clinicBody = body.clinic ?? body;

  if (organizationBody && req.auth!.organizationRole !== 'owner') {
    return res.status(403).json({ error: 'Only organization owners can update organization settings' });
  }

  const [updatedOrganization, updated] = await prisma.$transaction([
    organizationBody
      ? prisma.organization.update({
          where: { id: organizationId },
          data: {
            name: organizationBody.name,
            phone: organizationBody.phone,
            email: organizationBody.email,
            website: organizationBody.website,
            about: organizationBody.about,
            services:
              organizationBody.services === null
                ? Prisma.JsonNull
                : organizationBody.services,
            planTier: organizationBody.planTier,
          },
        })
      : prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    prisma.clinic.update({
    where: { id: clinicId },
    data: {
      name:                clinicBody.name,
      phone:               clinicBody.phone,
      timezone:            clinicBody.timezone,
      googleCalendarId:    clinicBody.googleCalendarId,
      clinicAddress:       clinicBody.clinicAddress,
      clinicEmail:         clinicBody.clinicEmail,
      clinicWebsite:       clinicBody.clinicWebsite,
      clinicAbout:         clinicBody.clinicAbout,
      clinicServices:
        clinicBody.clinicServices === null
          ? Prisma.JsonNull
          : clinicBody.clinicServices,
      businessHours:       clinicBody.businessHours,
    },
    }),
  ]);

  const { googleTokens: _tokens, ...safe } = updated as typeof updated & { googleTokens?: string };
  await auditAction(req, 'settings.updated', {
    organizationId,
    targetType: 'Clinic',
    targetId: clinicId,
  });
  res.json({ organization: updatedOrganization, clinic: safe });
});

export default router;
