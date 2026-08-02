import { Request, Response } from 'express';
import { z } from 'zod';
import { createRouter } from '../../lib/asyncRouter';
import { prisma } from '../../lib/prisma';
import { requirePermission } from '../../auth/middleware';
import { auditAction } from '../../auth/audit';
import {
  DAY_NAMES,
  DayName,
  dayIndexToName,
  dayNameToIndex,
  weeklyHoursSchema,
  WeeklyHours,
} from '../../lib/businessHoursSchema';

const router = createRouter();

const doctorIdSchema = z.string().uuid();

/**
 * A doctor's weekly availability is an OVERRIDE, scoped to the currently
 * active clinic. Any day left out (or explicitly null) falls back to that
 * clinic's own business hours — see services/googleCalendar.ts
 * getAvailableSlots, which already implements this exact fallback and is
 * unchanged by this file. This route only adds the missing write path plus
 * a read path shaped for the dashboard UI.
 */
async function loadDoctorScopedToActiveClinic(
  doctorId: string,
  organizationId: string,
  clinicId: string
) {
  return prisma.doctor.findFirst({
    where: { id: doctorId, organizationId, clinics: { some: { clinicId } } },
    select: { id: true },
  });
}

async function currentAvailabilityPayload(doctorId: string, organizationId: string, clinicId: string) {
  const [rows, clinic] = await Promise.all([
    prisma.doctorAvailability.findMany({
      where: { doctorId, organizationId, clinicId },
      select: { dayOfWeek: true, open: true, close: true },
    }),
    prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { businessHours: true },
    }),
  ]);

  const availability: WeeklyHours = {};
  for (const row of rows) {
    availability[dayIndexToName(row.dayOfWeek)] = { open: row.open, close: row.close };
  }

  return {
    doctorId,
    clinicId,
    availability,
    inheritedBusinessHours: clinic.businessHours as WeeklyHours,
  };
}

router.get(
  '/dashboard/doctors/:id/availability',
  requirePermission('dashboard:read'),
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const clinicId = req.auth!.clinicId;
    const parsedId = doctorIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid doctor ID' });

    const doctor = await loadDoctorScopedToActiveClinic(parsedId.data, organizationId, clinicId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    res.json(await currentAvailabilityPayload(doctor.id, organizationId, clinicId));
  }
);

router.put(
  '/dashboard/doctors/:id/availability',
  requirePermission('settings:write'),
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const clinicId = req.auth!.clinicId;
    const parsedId = doctorIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid doctor ID' });

    const parsedBody = weeklyHoursSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({ error: parsedBody.error.issues[0]?.message ?? 'Invalid availability data' });
    }

    const doctor = await loadDoctorScopedToActiveClinic(parsedId.data, organizationId, clinicId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    // Full replace, matching how clinic business hours themselves are edited
    // as one JSON blob — a day omitted from the request is the same as an
    // explicit `null`, and just means "no override, inherit clinic hours".
    const rowsToCreate = DAY_NAMES.map((day) => ({ day, hours: parsedBody.data[day] }))
      .filter(
        (entry): entry is { day: DayName; hours: { open: string; close: string } } =>
          entry.hours != null
      )
      .map(({ day, hours }) => ({
        organizationId,
        doctorId: doctor.id,
        clinicId,
        dayOfWeek: dayNameToIndex(day),
        open: hours.open,
        close: hours.close,
      }));

    await prisma.$transaction(async (tx) => {
      await tx.doctorAvailability.deleteMany({
        where: { doctorId: doctor.id, organizationId, clinicId },
      });
      if (rowsToCreate.length > 0) {
        await tx.doctorAvailability.createMany({ data: rowsToCreate });
      }
    });

    await auditAction(req, 'doctor.availability_updated', {
      organizationId,
      targetType: 'Doctor',
      targetId: doctor.id,
    });

    res.json(await currentAvailabilityPayload(doctor.id, organizationId, clinicId));
  }
);

export default router;
