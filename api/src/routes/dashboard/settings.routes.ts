import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { createRouter } from '../../lib/asyncRouter';
import { prisma } from '../../lib/prisma';
import { auditAction } from '../../auth/audit';
import { requirePermission } from '../../auth/middleware';
import { toE164 } from '../../lib/phone';
import { publicClinicSelect } from '../../services/publicClinic';

const router = createRouter();

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const nullableEmail = z
  .union([z.string().trim().email().max(254), z.literal(''), z.null()])
  .transform((value) => value === '' ? null : value);
const serviceList = z.array(z.string().trim().min(1).max(160)).max(100).nullable();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use HH:MM format');
const openingHours = z.object({ open: time, close: time }).strict().nullable();
const businessHours = z.object({
  mon: openingHours.optional(),
  tue: openingHours.optional(),
  wed: openingHours.optional(),
  thu: openingHours.optional(),
  fri: openingHours.optional(),
  sat: openingHours.optional(),
  sun: openingHours.optional(),
}).strict();

const timezone = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'Invalid timezone');

const organizationSettingsSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  phone: nullableText(40).optional(),
  email: nullableEmail.optional(),
  website: nullableText(2048).optional(),
  about: nullableText(5000).optional(),
  services: serviceList.optional(),
  // planTier is deliberately not writable from tenant-managed settings.
});

const clinicSettingsSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  timezone: timezone.optional(),
  googleCalendarId: nullableText(1024).optional(),
  clinicAddress: nullableText(1000).optional(),
  clinicEmail: nullableEmail.optional(),
  clinicWebsite: nullableText(2048).optional(),
  clinicAbout: nullableText(5000).optional(),
  clinicServices: serviceList.optional(),
  businessHours: businessHours.optional(),
});

const settingsUpdateSchema = clinicSettingsSchema.extend({
  organization: organizationSettingsSchema.optional(),
  clinic: clinicSettingsSchema.optional(),
}).refine((body) => {
  const nestedOrganizationFields = body.organization
    ? Object.keys(body.organization).length
    : 0;
  const nestedClinicFields = body.clinic ? Object.keys(body.clinic).length : 0;
  const { organization: _organization, clinic: _clinic, ...flatClinicFields } = body;

  return nestedOrganizationFields + nestedClinicFields + Object.keys(flatClinicFields).length > 0;
}, 'At least one settings field is required');

function invalidSettingsRequest(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid settings data' });
}

router.get('/dashboard/settings', requirePermission('settings:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const [organization, clinic, doctors] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId } }),
    prisma.clinic.findUnique({ where: { id: clinicId }, select: publicClinicSelect }),
    prisma.doctor.findMany({
      where: { organizationId, clinics: { some: { clinicId } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  res.json({ organization, clinic, doctors });
});

router.patch('/dashboard/settings', requirePermission('settings:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const parsed = settingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return invalidSettingsRequest(res, parsed.error);
  const body = parsed.data;

  const organizationBody = body.organization;
  const clinicBody = body.clinic ?? body;

  if (organizationBody && req.auth!.organizationRole !== 'owner') {
    return res.status(403).json({ error: 'Only organization owners can update organization settings' });
  }

  let normalizedClinicPhone = clinicBody.phone;
  if (clinicBody.phone) {
    const clinicCallingCode = await prisma.clinic.findFirst({
      where: { id: clinicId, organizationId },
      select: { defaultCallingCode: true },
    });
    if (!clinicCallingCode) return res.status(404).json({ error: 'Clinic not found' });
    try {
      normalizedClinicPhone = toE164(clinicBody.phone, clinicCallingCode.defaultCallingCode);
    } catch {
      return res.status(400).json({ error: 'Invalid clinic phone number' });
    }
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
          },
        })
      : prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    prisma.clinic.update({
      where: { id: clinicId },
      data: {
        name: clinicBody.name,
        phone: normalizedClinicPhone,
        timezone: clinicBody.timezone,
        googleCalendarId: clinicBody.googleCalendarId,
        clinicAddress: clinicBody.clinicAddress,
        clinicEmail: clinicBody.clinicEmail,
        clinicWebsite: clinicBody.clinicWebsite,
        clinicAbout: clinicBody.clinicAbout,
        clinicServices:
          clinicBody.clinicServices === null
            ? Prisma.JsonNull
            : clinicBody.clinicServices,
        businessHours: clinicBody.businessHours,
      },
      select: publicClinicSelect,
    }),
  ]);

  await auditAction(req, 'settings.updated', {
    organizationId,
    targetType: 'Clinic',
    targetId: clinicId,
  });
  res.json({ organization: updatedOrganization, clinic: updated });
});

export default router;
