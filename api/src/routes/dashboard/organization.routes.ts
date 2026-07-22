import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { auditAction, getRequestMeta } from '../../auth/audit';
import {
  requireMfaForSensitiveAction,
  requirePermission,
} from '../../auth/middleware';
import { prisma } from '../../lib/prisma';
import { toE164 } from '../../lib/phone';
import { createRouter } from '../../lib/asyncRouter';

const router = createRouter();
const role = z.enum(['owner', 'admin', 'staff', 'viewer']);
const uuid = z.string().uuid();
const timezone = z.string().trim().min(1).max(100).refine(value => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'Invalid IANA timezone');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
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

const memberQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const memberUpdate = z.object({
  organizationRole: role.nullable().optional(),
  clinicAssignments: z.array(z.object({
    clinicId: uuid,
    role: role.nullable(),
  }).strict()).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.organizationRole === undefined && value.clinicAssignments === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'No membership changes supplied' });
  }
  const clinicIds = value.clinicAssignments?.map(item => item.clinicId) ?? [];
  if (new Set(clinicIds).size !== clinicIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Clinic assignments must be unique' });
  }
});

const clinicCreate = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(30),
  timezone,
  countryCode: z.string().trim().regex(/^[A-Z]{2}$/).default('IN'),
  defaultCallingCode: z.string().trim().regex(/^\d{1,4}$/).default('91'),
  locale: z.string().trim().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).default('en-IN'),
  businessHours: businessHours.optional(),
}).strict();
const clinicStatusUpdate = z.object({
  status: z.enum(['active', 'archived']),
}).strict();

function requireOrganizationOwner(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.organizationRole !== 'owner') {
    return res.status(403).json({ error: 'Organization owner access required' });
  }
  return next();
}

router.get(
  '/dashboard/organization/members',
  requirePermission('users:manage'),
  requireOrganizationOwner,
  async (req, res) => {
    const parsed = memberQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid member query' });
    const { page, limit } = parsed.data;
    const organizationId = req.auth!.organizationId;
    const tenantWhere: Prisma.UserWhereInput = {
      OR: [
        { organizationMemberships: { some: { organizationId } } },
        { memberships: { some: { organizationId } } },
      ],
    };

    const [members, total, pendingInvites] = await Promise.all([
      prisma.user.findMany({
        where: tenantWhere,
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          mfaRequired: true,
          organizationMemberships: {
            where: { organizationId },
            select: { role: true },
          },
          memberships: {
            where: { organizationId },
            select: { clinicId: true, role: true, clinic: { select: { name: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where: tenantWhere }),
      prisma.inviteToken.findMany({
        where: {
          organizationId,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          email: true,
          organizationRole: true,
          clinicRole: true,
          clinicId: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);

    return res.json({
      members: members.map(member => ({
        id: member.id,
        name: member.name,
        email: member.email,
        status: member.status,
        mfaRequired: member.mfaRequired,
        organizationRole: member.organizationMemberships[0]?.role ?? null,
        clinicAssignments: member.memberships,
      })),
      pendingInvites,
      total,
      page,
      limit,
    });
  }
);

router.patch(
  '/dashboard/organization/members/:userId',
  requirePermission('users:manage'),
  requireOrganizationOwner,
  requireMfaForSensitiveAction,
  async (req, res) => {
    const userId = uuid.safeParse(req.params.userId);
    const parsed = memberUpdate.safeParse(req.body);
    if (!userId.success || !parsed.success) {
      return res.status(400).json({ error: 'Invalid membership update' });
    }
    const organizationId = req.auth!.organizationId;
    const lockKey = `organization-members:${organizationId}`;

    try {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const target = await tx.user.findFirst({
          where: {
            id: userId.data,
            OR: [
              { organizationMemberships: { some: { organizationId } } },
              { memberships: { some: { organizationId } } },
            ],
          },
          select: {
            id: true,
            organizationMemberships: {
              where: { organizationId },
              select: { role: true },
            },
          },
        });
        if (!target) throw new MembershipChangeError('Member not found', 404);

        const currentOrganizationRole = target.organizationMemberships[0]?.role ?? null;
        const nextOrganizationRole = parsed.data.organizationRole;
        if (
          currentOrganizationRole === 'owner' &&
          nextOrganizationRole !== undefined &&
          nextOrganizationRole !== 'owner'
        ) {
          const ownerCount = await tx.organizationMembership.count({
            where: { organizationId, role: 'owner' },
          });
          if (ownerCount <= 1) {
            throw new MembershipChangeError('The organization must retain at least one owner', 409);
          }
        }

        if (nextOrganizationRole !== undefined) {
          if (nextOrganizationRole === null) {
            await tx.organizationMembership.deleteMany({
              where: { organizationId, userId: target.id },
            });
          } else {
            await tx.organizationMembership.upsert({
              where: { userId_organizationId: { userId: target.id, organizationId } },
              create: { userId: target.id, organizationId, role: nextOrganizationRole },
              update: { role: nextOrganizationRole },
            });
            if (nextOrganizationRole === 'owner') {
              await tx.user.update({ where: { id: target.id }, data: { mfaRequired: true } });
            }
          }
        }

        if (parsed.data.clinicAssignments) {
          const activeAssignmentIds = parsed.data.clinicAssignments
            .filter(item => item.role !== null)
            .map(item => item.clinicId);
          const removalIds = parsed.data.clinicAssignments
            .filter(item => item.role === null)
            .map(item => item.clinicId);
          const [activeAssignmentCount, removalClinicCount] = await Promise.all([
            tx.clinic.count({
              where: {
                organizationId,
                status: 'active',
                id: { in: activeAssignmentIds },
              },
            }),
            tx.clinic.count({
              where: { organizationId, id: { in: removalIds } },
            }),
          ]);
          if (
            activeAssignmentCount !== activeAssignmentIds.length ||
            removalClinicCount !== removalIds.length
          ) {
            throw new MembershipChangeError('A clinic does not belong to this organization', 403);
          }
          for (const assignment of parsed.data.clinicAssignments) {
            if (assignment.role === null) {
              await tx.clinicMembership.deleteMany({
                where: { organizationId, clinicId: assignment.clinicId, userId: target.id },
              });
            } else {
              await tx.clinicMembership.upsert({
                where: { userId_clinicId: { userId: target.id, clinicId: assignment.clinicId } },
                create: {
                  userId: target.id,
                  organizationId,
                  clinicId: assignment.clinicId,
                  role: assignment.role,
                },
                update: { role: assignment.role, organizationId },
              });
              if (assignment.role === 'owner') {
                await tx.user.update({ where: { id: target.id }, data: { mfaRequired: true } });
              }
            }
          }
        }

        const remainingAccess = await tx.user.findFirst({
          where: {
            id: target.id,
            OR: [
              { organizationMemberships: { some: { organizationId } } },
              { memberships: { some: { organizationId } } },
            ],
          },
          select: { id: true },
        });
        if (!remainingAccess && target.id === req.auth!.userId) {
          // Self-removal is allowed only when the caller explicitly left at
          // least one other owner; their current session loses access on its
          // next request. No special bypass is retained.
          return;
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof MembershipChangeError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    await auditAction(req, 'organization.member_updated', {
      targetType: 'User',
      targetId: userId.data,
      metadata: {
        organizationRole: parsed.data.organizationRole,
        clinicIds: parsed.data.clinicAssignments?.map(item => item.clinicId),
      },
    });
    return res.json({ success: true });
  }
);

router.delete(
  '/dashboard/organization/invites/:inviteId',
  requirePermission('users:manage'),
  requireOrganizationOwner,
  requireMfaForSensitiveAction,
  async (req, res) => {
    const inviteId = uuid.safeParse(req.params.inviteId);
    if (!inviteId.success) return res.status(400).json({ error: 'Invalid invite ID' });
    const removed = await prisma.inviteToken.deleteMany({
      where: {
        id: inviteId.data,
        organizationId: req.auth!.organizationId,
        acceptedAt: null,
      },
    });
    if (removed.count === 0) return res.status(404).json({ error: 'Invite not found' });
    await auditAction(req, 'organization.invite_revoked', {
      targetType: 'InviteToken',
      targetId: inviteId.data,
    });
    return res.json({ success: true });
  }
);

router.get(
  '/dashboard/organization/clinics',
  requirePermission('settings:read'),
  requireOrganizationOwner,
  async (req, res) => {
    const now = new Date();
    const clinics = await prisma.clinic.findMany({
      where: { organizationId: req.auth!.organizationId },
      select: {
        id: true,
        name: true,
        phone: true,
        timezone: true,
        countryCode: true,
        locale: true,
        status: true,
        archivedAt: true,
        createdAt: true,
        _count: {
          select: {
            memberships: true,
            appointments: {
              where: {
                startAt: { gte: now },
                status: { in: ['scheduled', 'confirmed'] },
              },
            },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
    return res.json({ clinics });
  }
);

router.patch(
  '/dashboard/organization/clinics/:clinicId/status',
  requirePermission('settings:write'),
  requireOrganizationOwner,
  requireMfaForSensitiveAction,
  async (req, res) => {
    const clinicId = uuid.safeParse(req.params.clinicId);
    const parsed = clinicStatusUpdate.safeParse(req.body);
    if (!clinicId.success || !parsed.success) {
      return res.status(400).json({ error: 'Invalid clinic status update' });
    }
    const organizationId = req.auth!.organizationId;
    const targetStatus = parsed.data.status;
    const now = new Date();
    const meta = getRequestMeta(req);

    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-clinics:${organizationId}`}, 0))`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commercial-access:${organizationId}`}, 0))`;
        const clinic = await tx.clinic.findFirst({
          where: { id: clinicId.data, organizationId },
          select: { id: true, name: true, status: true },
        });
        if (!clinic) throw new MembershipChangeError('Clinic not found', 404);
        if (clinic.status === targetStatus) return { clinic, duplicate: true };

        if (targetStatus === 'archived') {
          const [activeClinicCount, futureAppointmentCount] = await Promise.all([
            tx.clinic.count({ where: { organizationId, status: 'active' } }),
            tx.appointment.count({
              where: {
                organizationId,
                clinicId: clinic.id,
                startAt: { gte: now },
                status: { in: ['scheduled', 'confirmed'] },
              },
            }),
          ]);
          if (activeClinicCount <= 1) {
            throw new MembershipChangeError('The organization must retain at least one active clinic', 409);
          }
          if (futureAppointmentCount > 0) {
            throw new MembershipChangeError(
              'Cancel or move future appointments before archiving this clinic',
              409
            );
          }

          const updated = await tx.clinic.update({
            where: { id: clinic.id },
            data: { status: 'archived', archivedAt: now },
            select: { id: true, name: true, status: true },
          });
          await tx.providerResource.updateMany({
            where: { organizationId, clinicId: clinic.id, status: 'active' },
            data: { status: 'inactive' },
          });
          await tx.inviteToken.deleteMany({
            where: { organizationId, clinicId: clinic.id, acceptedAt: null },
          });
          await tx.communicationAttempt.updateMany({
            where: {
              organizationId,
              clinicId: clinic.id,
              externalId: null,
              status: 'pending',
            },
            data: {
              status: 'cancelled',
              errorCode: 'clinic_archived',
              errorMessage: 'Cancelled before provider submission because the clinic was archived',
              endedAt: now,
              usageFinalizedAt: now,
            },
          });
          await tx.auditLog.create({
            data: {
              userId: req.auth!.userId,
              organizationId,
              clinicId: clinic.id,
              action: 'organization.clinic_archived',
              targetType: 'Clinic',
              targetId: clinic.id,
              ...meta,
            },
          });
          return { clinic: updated, duplicate: false };
        }

        const organization = await tx.organization.findUnique({
          where: { id: organizationId },
          select: {
            status: true,
            entitlements: {
              where: {
                key: 'clinics.max',
                enabled: true,
                effectiveAt: { lte: now },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
              select: { limit: true },
              take: 1,
            },
          },
        });
        if (!organization || !['active', 'past_due_grace'].includes(organization.status)) {
          throw new MembershipChangeError('An active subscription is required', 402);
        }
        const entitlement = organization.entitlements[0];
        const devBypass =
          process.env.NODE_ENV !== 'production' &&
          process.env.ALLOW_UNENTITLED_DEV_ACCESS === 'true';
        if (!entitlement?.limit && !devBypass) {
          throw new MembershipChangeError('The current plan does not allow this clinic to be restored', 402);
        }
        const activeClinicCount = await tx.clinic.count({
          where: { organizationId, status: 'active' },
        });
        if (
          entitlement?.limit &&
          new Prisma.Decimal(activeClinicCount + 1).greaterThan(entitlement.limit)
        ) {
          throw new MembershipChangeError('The plan clinic limit has been reached', 402);
        }

        const updated = await tx.clinic.update({
          where: { id: clinic.id },
          data: { status: 'active', archivedAt: null },
          select: { id: true, name: true, status: true },
        });
        await tx.auditLog.create({
          data: {
            userId: req.auth!.userId,
            organizationId,
            clinicId: clinic.id,
            action: 'organization.clinic_restored',
            targetType: 'Clinic',
            targetId: clinic.id,
            metadata: { providerResourcesRequireReview: true },
            ...meta,
          },
        });
        return { clinic: updated, duplicate: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      return res.json({
        ...result,
        providerResourcesRequireReview: targetStatus === 'active',
      });
    } catch (error) {
      if (error instanceof MembershipChangeError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }
  }
);

router.post(
  '/dashboard/organization/clinics',
  requirePermission('settings:write'),
  requireOrganizationOwner,
  requireMfaForSensitiveAction,
  async (req, res) => {
    const parsed = clinicCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid clinic details' });
    const organizationId = req.auth!.organizationId;
    const now = new Date();
    let phone: string;
    try {
      phone = toE164(parsed.data.phone, parsed.data.defaultCallingCode);
    } catch {
      return res.status(400).json({ error: 'Invalid clinic phone number' });
    }
    const lockKey = `organization-clinics:${organizationId}`;

    try {
      const clinic = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const organization = await tx.organization.findUnique({
          where: { id: organizationId },
          select: {
            status: true,
            entitlements: {
              where: {
                key: 'clinics.max',
                enabled: true,
                effectiveAt: { lte: now },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
              select: { limit: true },
              take: 1,
            },
          },
        });
        if (!organization || !['active', 'past_due_grace'].includes(organization.status)) {
          throw new MembershipChangeError('An active subscription is required', 402);
        }
        const entitlement = organization.entitlements[0];
        const devBypass =
          process.env.NODE_ENV !== 'production' &&
          process.env.ALLOW_UNENTITLED_DEV_ACCESS === 'true';
        if (!entitlement?.limit && !devBypass) {
          throw new MembershipChangeError('The current plan does not allow additional clinics', 402);
        }
        const existingCount = await tx.clinic.count({
          where: { organizationId, status: 'active' },
        });
        if (entitlement?.limit && new Prisma.Decimal(existingCount + 1).greaterThan(entitlement.limit)) {
          throw new MembershipChangeError('The plan clinic limit has been reached', 402);
        }

        const created = await tx.clinic.create({
          data: {
            organizationId,
            name: parsed.data.name,
            phone,
            timezone: parsed.data.timezone,
            countryCode: parsed.data.countryCode,
            defaultCallingCode: parsed.data.defaultCallingCode,
            locale: parsed.data.locale,
            businessHours: parsed.data.businessHours ?? {
              mon: { open: '09:00', close: '18:00' },
              tue: { open: '09:00', close: '18:00' },
              wed: { open: '09:00', close: '18:00' },
              thu: { open: '09:00', close: '18:00' },
              fri: { open: '09:00', close: '18:00' },
              sat: { open: '09:00', close: '14:00' },
              sun: null,
            },
          },
        });
        await tx.clinicMembership.upsert({
          where: { userId_clinicId: { userId: req.auth!.userId, clinicId: created.id } },
          create: {
            userId: req.auth!.userId,
            organizationId,
            clinicId: created.id,
            role: 'owner',
          },
          update: { role: 'owner', organizationId },
        });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      await auditAction(req, 'organization.clinic_created', {
        clinicId: clinic.id,
        targetType: 'Clinic',
        targetId: clinic.id,
      });
      return res.status(201).json({ clinic });
    } catch (error) {
      if (error instanceof MembershipChangeError) {
        return res.status(error.status).json({ error: error.message });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return res.status(409).json({ error: 'A clinic with this phone already exists' });
      }
      throw error;
    }
  }
);

class MembershipChangeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export default router;
