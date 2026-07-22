import { Request, Response } from 'express';
import { Prisma, type User } from '@prisma/client';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma';
import { auditAction, getRequestMeta, securityEvent } from '../auth/audit';
import { EMAIL_VERIFY_TTL_HOURS, INVITE_TTL_HOURS, PASSWORD_RESET_TTL_MINUTES } from '../auth/config';
import { AuthSelectionError, buildAuthContextForUser } from '../auth/context';
import { generateToken, hashPassword, hashToken, safeTokenEqual, verifyPassword } from '../auth/crypto';
import {
  hasFreshMfaVerification,
  requireAuth,
  requireClinic,
  requireCsrf,
  requireMfaForSensitiveAction,
  requirePermission,
} from '../auth/middleware';
import { authRateLimit } from '../auth/rateLimit';
import { clearSessionCookie, createSession, rotateCsrfToken } from '../auth/sessions';
import { sendInviteEmail, sendPasswordResetEmail, sendVerifyEmail } from '../auth/mailer';
import { cleanupConsumedAuthTokens } from '../auth/tokenCleanup';
import type { AuthContext } from '../auth/types';
import { decryptSecret, encryptSecret } from '../auth/secretBox';
import { toE164 } from '../lib/phone';
import { createRouter } from '../lib/asyncRouter';

const router = createRouter();

const emailSchema = z.string().email().transform((v) => v.trim().toLowerCase());
const passwordSchema = z.string().min(12).max(200);

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  totpCode: z.string().trim().min(6).max(10).optional(),
  recoveryCode: z.string().trim().min(8).max(200).optional(),
});

const inviteSchema = z.object({
  email: emailSchema,
  organizationRole: z.enum(['owner', 'admin', 'viewer']).optional(),
  clinicRole: z.enum(['admin', 'staff', 'viewer']).optional(),
  clinicId: z.string().min(1).optional(),
});

const acceptInviteSchema = z.object({
  token: z.string().min(20),
  name: z.string().trim().min(1).max(120),
  password: passwordSchema,
});

const forgotPasswordSchema = z.object({ email: emailSchema });
const resendVerificationSchema = z.object({ email: emailSchema }).strict();

const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});

const verifyEmailSchema = z.object({ token: z.string().min(20) });

const mfaVerifySchema = z.object({ code: z.string().trim().min(6).max(10) });

const organizationRegistrationSchema = z.object({
  ownerName: z.string().trim().min(2).max(120),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(2).max(160),
  clinicName: z.string().trim().min(2).max(160),
  clinicPhone: z.string().trim().min(7).max(30),
  timezone: z.string().trim().min(1).max(100).refine(value => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA timezone'),
  countryCode: z.string().trim().regex(/^[A-Z]{2}$/).default('IN'),
  defaultCallingCode: z.string().trim().regex(/^\d{1,4}$/).default('91'),
  locale: z.string().trim().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).default('en-IN'),
  acceptTerms: z.literal(true),
}).strict();

class RegistrationRequestError extends Error {
  constructor(
    readonly code: 'idempotency_conflict' | 'registration_in_progress' | 'email_exists',
    message: string
  ) {
    super(message);
  }
}

class InviteAcceptanceStateError extends Error {}

function registrationIdempotencyKey(req: Request): string | null {
  const key = req.header('idempotency-key')?.trim();
  return key && /^[A-Za-z0-9._:-]{8,200}$/.test(key) ? key : null;
}

function registrationRequestHash(input: z.infer<typeof organizationRegistrationSchema>): string {
  // The password is deliberately excluded so this durable record cannot be
  // used as an offline password oracle after a database compromise.
  const { password: _password, ...nonSecretInput } = input;
  return hashToken(JSON.stringify(nonSecretInput));
}

function publicAuth(auth: AuthContext) {
  return {
    user: {
      id: auth.userId,
      email: auth.email,
      name: auth.name,
    },
    activeOrganization: {
      id: auth.organizationId,
      role: auth.organizationRole,
    },
    activeClinic: {
      id: auth.clinicId,
      organizationId: auth.organizationId,
      role: auth.role,
      clinicRole: auth.clinicRole,
    },
    organizations: auth.organizations,
    clinics: auth.clinics,
    memberships: auth.memberships,
  };
}

function genericLoginError(res: Response) {
  return res.status(401).json({ error: 'Invalid email or password' });
}

async function consumeMfaRecoveryCode(userId: string, recoveryCode: string): Promise<boolean> {
  const suppliedHash = hashToken(recoveryCode);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa-recovery:${userId}`}, 0))`;
    const method = await tx.mfaMethod.findUnique({
      where: { userId_type: { userId, type: 'totp' } },
      select: { id: true, enabledAt: true, recoveryCodes: true },
    });
    if (!method?.enabledAt || !Array.isArray(method.recoveryCodes)) return false;

    const recoveryCodes = method.recoveryCodes.filter(
      (value): value is string => typeof value === 'string'
    );
    const matchedIndex = recoveryCodes.findIndex(storedHash =>
      safeTokenEqual(storedHash, suppliedHash)
    );
    if (matchedIndex < 0) return false;

    await tx.mfaMethod.update({
      where: { id: method.id },
      data: { recoveryCodes: recoveryCodes.filter((_code, index) => index !== matchedIndex) },
    });
    return true;
  });
}

router.post('/auth/register-organization', authRateLimit, async (req: Request, res: Response) => {
  const parsed = organizationRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid organization registration details' });
  }

  const input = parsed.data;
  const rawIdempotencyKey = registrationIdempotencyKey(req);
  if (!rawIdempotencyKey) {
    return res.status(400).json({
      error: 'A stable Idempotency-Key header (8-200 letters, numbers, dot, colon, underscore, or dash) is required',
    });
  }
  const idempotencyKeyHash = hashToken(rawIdempotencyKey);
  const requestHash = registrationRequestHash(input);

  let clinicPhone: string;
  try {
    clinicPhone = toE164(input.clinicPhone, input.defaultCallingCode);
  } catch {
    return res.status(400).json({ error: 'Invalid clinic phone number' });
  }

  try {
    const passwordHash = await hashPassword(input.password);
    const registration = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`registration:${idempotencyKeyHash}`}, 0))`;
      const existingRequest = await tx.organizationRegistrationRequest.findUnique({
        where: { idempotencyKeyHash },
      });
      if (existingRequest) {
        if (existingRequest.requestHash !== requestHash) {
          throw new RegistrationRequestError(
            'idempotency_conflict',
            'This Idempotency-Key was already used for different registration details'
          );
        }
        if (
          existingRequest.status === 'completed' &&
          existingRequest.userId &&
          existingRequest.organizationId &&
          existingRequest.clinicId
        ) {
          return {
            requestId: existingRequest.id,
            userId: existingRequest.userId,
            organizationId: existingRequest.organizationId,
            clinicId: existingRequest.clinicId,
            verificationDeliveryStatus: existingRequest.verificationDeliveryStatus,
            replayed: true,
          };
        }
        throw new RegistrationRequestError(
          'registration_in_progress',
          'This registration request is still being processed; retry shortly with the same Idempotency-Key'
        );
      }

      const existingUser = await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existingUser) {
        throw new RegistrationRequestError(
          'email_exists',
          'An account already exists for this email. Sign in to create or join another organization.'
        );
      }

      const request = await tx.organizationRegistrationRequest.create({
        data: { idempotencyKeyHash, requestHash },
      });
      const user = await tx.user.create({
        data: {
          email: input.email,
          name: input.ownerName,
          passwordHash,
          status: 'active',
          mfaRequired: true,
        },
      });
      const organization = await tx.organization.create({
        data: {
          name: input.organizationName,
          email: input.email,
          phone: clinicPhone,
          status: 'provisioning',
          dataRegion: input.countryCode,
        },
      });
      const clinic = await tx.clinic.create({
        data: {
          organizationId: organization.id,
          name: input.clinicName,
          phone: clinicPhone,
          timezone: input.timezone,
          countryCode: input.countryCode,
          defaultCallingCode: input.defaultCallingCode,
          locale: input.locale,
          businessHours: {
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

      await tx.organizationMembership.create({
        data: { userId: user.id, organizationId: organization.id, role: 'owner' },
      });
      await tx.clinicMembership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          clinicId: clinic.id,
          role: 'owner',
        },
      });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          clinicId: clinic.id,
          action: 'auth.organization_registered',
          targetType: 'Organization',
          targetId: organization.id,
          metadata: {
            termsVersion: process.env.TERMS_VERSION ?? '2026-07-13',
            privacyVersion: process.env.PRIVACY_VERSION ?? '2026-07-13',
            registrationRequestId: request.id,
          },
          ...getRequestMeta(req),
        },
      });
      await tx.organizationRegistrationRequest.update({
        where: { id: request.id },
        data: {
          status: 'completed',
          userId: user.id,
          organizationId: organization.id,
          clinicId: clinic.id,
          completedAt: new Date(),
        },
      });

      return {
        requestId: request.id,
        userId: user.id,
        organizationId: organization.id,
        clinicId: clinic.id,
        verificationDeliveryStatus: 'pending',
        replayed: false,
      };
    });

    let shouldSendVerification = false;
    let deliveryPending = registration.verificationDeliveryStatus !== 'sent';
    if (deliveryPending) {
      const deliveryClaim = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`registration-email:${idempotencyKeyHash}`}, 0))`;
        const request = await tx.organizationRegistrationRequest.findUniqueOrThrow({
          where: { id: registration.requestId },
        });
        if (request.verificationDeliveryStatus === 'sent') return 'sent';
        const sendingLeaseActive =
          request.verificationDeliveryStatus === 'sending' &&
          request.updatedAt.getTime() > Date.now() - 5 * 60 * 1000;
        if (sendingLeaseActive) return 'sending';
        await tx.organizationRegistrationRequest.update({
          where: { id: request.id },
          data: { verificationDeliveryStatus: 'sending' },
        });
        return 'claimed';
      });
      shouldSendVerification = deliveryClaim === 'claimed';
      deliveryPending = deliveryClaim !== 'sent';
    }

    if (shouldSendVerification) {
      try {
        await createEmailVerificationToken(registration.userId, input.email);
        await prisma.organizationRegistrationRequest.update({
          where: { id: registration.requestId },
          data: { verificationDeliveryStatus: 'sent' },
        });
        deliveryPending = false;
      } catch {
        console.error('Registration verification email could not be sent', {
          userId: registration.userId,
        });
        await prisma.organizationRegistrationRequest.updateMany({
          where: { id: registration.requestId, verificationDeliveryStatus: 'sending' },
          data: { verificationDeliveryStatus: 'failed' },
        }).catch(() => undefined);
        deliveryPending = true;
      }
    }

    return res.status(deliveryPending ? 202 : registration.replayed ? 200 : 201).json({
      success: true,
      emailVerificationRequired: true,
      verificationDeliveryPending: deliveryPending || undefined,
      organizationId: registration.organizationId,
      replayed: registration.replayed,
    });
  } catch (error) {
    if (error instanceof RegistrationRequestError) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({
        error: 'An account already exists for this email. Sign in to create or join another organization.',
      });
    }
    throw error;
  }
});

router.post('/auth/login', authRateLimit, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return genericLoginError(res);

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    include: { mfaMethods: true },
  });

  if (!user || user.status !== 'active') {
    await securityEvent(req, 'login_failed', { metadata: { email: parsed.data.email } });
    return genericLoginError(res);
  }

  const ok = await verifyPassword(user.passwordHash, parsed.data.password);
  if (!ok) {
    await securityEvent(req, 'login_failed', { userId: user.id });
    return genericLoginError(res);
  }

  if (!user.emailVerifiedAt) {
    await securityEvent(req, 'login_blocked_unverified_email', { userId: user.id });
    return res.status(403).json({ error: 'Email verification required', emailVerificationRequired: true });
  }

  let mfaVerified = false;
  const totp = user.mfaMethods.find((m) => m.type === 'totp' && m.enabledAt && m.secret);
  if (totp) {
    if (!parsed.data.totpCode && !parsed.data.recoveryCode) {
      await securityEvent(req, 'mfa_required', { userId: user.id });
      return res.status(202).json({ mfaRequired: true });
    }

    const validTotp = parsed.data.totpCode
      ? authenticator.check(
          parsed.data.totpCode,
          decryptSecret(totp.secret!, `mfa:totp:${user.id}`)
        )
      : false;

    let validRecovery = false;
    if (!validTotp && parsed.data.recoveryCode) {
      validRecovery = await consumeMfaRecoveryCode(user.id, parsed.data.recoveryCode);
      if (validRecovery) {
        await securityEvent(req, 'mfa_recovery_code_used', { userId: user.id });
      }
    }

    if (!validTotp && !validRecovery) {
      await securityEvent(req, 'mfa_failed', { userId: user.id });
      return res.status(401).json({ error: 'Invalid MFA code' });
    }
    mfaVerified = true;
  }

  let initialAuth: AuthContext;
  try {
    initialAuth = await buildAuthContextForUser(user.id, '');
  } catch (err) {
    if (err instanceof AuthSelectionError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const { csrfToken, sessionId } = await createSession(req, res, user.id, { mfaVerified });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
  await auditAction(req, 'auth.login', { userId: user.id });

  res.json({ ...publicAuth({ ...initialAuth, sessionId }), csrfToken });
});

router.post('/auth/logout', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  await prisma.session.update({
    where: { id: req.auth!.sessionId },
    data: { revokedAt: new Date() },
  });
  clearSessionCookie(res);
  await auditAction(req, 'auth.logout');
  res.json({ success: true });
});

router.post('/auth/logout-all', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  await prisma.session.updateMany({
    where: { userId: req.auth!.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  clearSessionCookie(res);
  await auditAction(req, 'auth.logout_all');
  res.json({ success: true });
});

router.get('/auth/me', requireAuth, (req: Request, res: Response) => {
  res.json(publicAuth(req.auth!));
});

router.get('/auth/csrf', requireAuth, async (req: Request, res: Response) => {
  const csrfToken = await rotateCsrfToken(req.auth!.sessionId);
  res.json({ csrfToken });
});

router.get('/auth/mfa/status', requireAuth, async (req: Request, res: Response) => {
  const [user, method, session] = await Promise.all([
    prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { mfaRequired: true },
    }),
    prisma.mfaMethod.findUnique({
      where: { userId_type: { userId: req.auth!.userId, type: 'totp' } },
      select: { enabledAt: true },
    }),
    prisma.session.findUnique({
      where: { id: req.auth!.sessionId },
      select: { mfaVerifiedAt: true },
    }),
  ]);
  if (!user || !session) return res.status(401).json({ error: 'Authentication required' });
  return res.json({
    required: user.mfaRequired,
    enabled: Boolean(method?.enabledAt),
    sessionVerified: hasFreshMfaVerification(session.mfaVerifiedAt),
  });
});

router.post('/auth/invites', requireAuth, requireClinic, requireCsrf, requirePermission('users:manage'), requireMfaForSensitiveAction,
  async (req: Request, res: Response) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid invite details' });

    const organizationRole = parsed.data.organizationRole;
    const clinicRole = parsed.data.clinicRole;
    const clinicId = parsed.data.clinicId;

    if (!organizationRole && !clinicRole) {
      return res.status(400).json({ error: 'Invite must include an organization or clinic role' });
    }

    if (clinicRole && !clinicId) {
      return res.status(400).json({ error: 'Clinic role requires a clinicId' });
    }

    if (!clinicRole && clinicId) {
      return res.status(400).json({ error: 'clinicId requires a clinic role' });
    }

    if (organizationRole && req.auth!.organizationRole !== 'owner') {
      return res.status(403).json({ error: 'Only an organization owner can grant organization access' });
    }
    const targetClinic = clinicId
      ? req.auth!.clinics.find(
          (clinic) => clinic.id === clinicId && clinic.organizationId === req.auth!.organizationId
        )
      : null;

    if (clinicId && !targetClinic) {
      return res.status(403).json({ error: 'Clinic access denied' });
    }

    const existingMember = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: {
        organizationMemberships: {
          where: { organizationId: req.auth!.organizationId },
          select: { id: true },
        },
        memberships: clinicId
          ? { where: { clinicId }, select: { id: true } }
          : false,
      },
    });
    if (
      existingMember?.organizationMemberships.length ||
      (clinicId && Array.isArray(existingMember?.memberships) && existingMember.memberships.length)
    ) {
      return res.status(409).json({ error: 'This user already has the requested tenant access' });
    }

    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    // await cleanupConsumedAuthTokens();
    await prisma.inviteToken.deleteMany({
      where: {
        organizationId: req.auth!.organizationId,
        clinicId: clinicId ?? null,
        email: parsed.data.email,
      },
    });

    const invite = await prisma.inviteToken.create({
      data: {
        organizationId: req.auth!.organizationId,
        clinicId,
        email: parsed.data.email,
        organizationRole,
        clinicRole,
        tokenHash: hashToken(token),
        expiresAt,
        createdById: req.auth!.userId,
      },
    });

    await sendInviteEmail(parsed.data.email, token);
    await auditAction(req, 'auth.invite_created', {
      targetType: 'InviteToken',
      targetId: invite.id,
      metadata: { email: parsed.data.email, organizationRole, clinicRole, clinicId },
    });

    res.json({ success: true });
  }
);

router.post('/auth/invites/accept', authRateLimit, async (req: Request, res: Response) => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid invite acceptance details' });

  const invite = await prisma.inviteToken.findUnique({
    where: { tokenHash: hashToken(parsed.data.token) },
  });

  if (invite && (invite.acceptedAt || invite.expiresAt <= new Date())) {
    await prisma.inviteToken.delete({ where: { id: invite.id } });
    return res.status(400).json({ error: 'Invite is invalid or expired' });
  }

  if (!invite) {
    return res.status(400).json({ error: 'Invite is invalid or expired' });
  }

  const existingAccount = await prisma.user.findUnique({ where: { email: invite.email } });
  if (
    existingAccount &&
    (existingAccount.status !== 'active' ||
      !(await verifyPassword(existingAccount.passwordHash, parsed.data.password)))
  ) {
    await securityEvent(req, 'invite_acceptance_failed', { userId: existingAccount.id });
    return res.status(401).json({ error: 'Invite or account credentials are invalid' });
  }

  const passwordHash = existingAccount ? null : await hashPassword(parsed.data.password);
  let user: User;
  try {
    user = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-clinics:${invite.organizationId}`}, 0))`;
    const durableInvite = await tx.inviteToken.findUnique({
      where: { id: invite.id },
      select: { id: true, clinicId: true, acceptedAt: true, expiresAt: true },
    });
    if (
      !durableInvite ||
      durableInvite.acceptedAt ||
      durableInvite.expiresAt <= new Date()
    ) {
      throw new InviteAcceptanceStateError('Invite is no longer active');
    }
    if (durableInvite.clinicId) {
      const activeClinic = await tx.clinic.findFirst({
        where: {
          id: durableInvite.clinicId,
          organizationId: invite.organizationId,
          status: 'active',
        },
        select: { id: true },
      });
      if (!activeClinic) throw new InviteAcceptanceStateError('Invite clinic is not active');
    }
    const current = await tx.user.findUnique({ where: { email: invite.email } });
    if ((current?.id ?? null) !== (existingAccount?.id ?? null)) {
      throw new Error('Account changed during invite acceptance');
    }
    const account =
      current ??
      (await tx.user.create({
        data: {
          email: invite.email,
          name: parsed.data.name,
          passwordHash: passwordHash!,
          emailVerifiedAt: new Date(),
          status: 'active',
        },
      }));

    if (current && !current.emailVerifiedAt) {
      await tx.user.update({
        where: { id: current.id },
        data: { emailVerifiedAt: new Date(), name: current.name || parsed.data.name },
      });
    }

    if (invite.organizationRole) {
      if (invite.organizationRole === 'owner') {
        await tx.user.update({ where: { id: account.id }, data: { mfaRequired: true } });
      }
      await tx.organizationMembership.upsert({
        where: {
          userId_organizationId: {
            userId: account.id,
            organizationId: invite.organizationId,
          },
        },
        // Invites grant missing access; they never silently downgrade or
        // replace a role that was assigned after the invitation was created.
        update: {},
        create: {
          userId: account.id,
          organizationId: invite.organizationId,
          role: invite.organizationRole,
        },
      });
    }

    if (invite.clinicId && invite.clinicRole) {
      if (invite.clinicRole === 'owner') {
        await tx.user.update({ where: { id: account.id }, data: { mfaRequired: true } });
      }
      await tx.clinicMembership.upsert({
        where: { userId_clinicId: { userId: account.id, clinicId: invite.clinicId } },
        update: {},
        create: {
          userId: account.id,
          organizationId: invite.organizationId,
          clinicId: invite.clinicId,
          role: invite.clinicRole,
        },
      });
    }

    await tx.inviteToken.delete({
      where: { id: invite.id },
    });

      return account;
    });
  } catch (error) {
    if (error instanceof InviteAcceptanceStateError) {
      await prisma.inviteToken.deleteMany({ where: { id: invite.id } });
      return res.status(400).json({ error: 'Invite is invalid or expired' });
    }
    throw error;
  }

  await auditAction(req, 'auth.invite_accepted', {
    userId: user.id,
    organizationId: invite.organizationId,
    clinicId: invite.clinicId,
    targetType: 'InviteToken',
    targetId: invite.id,
  });

  // Never mint a session from possession of an invite link. Existing users
  // must complete their normal password + MFA login, and new users enter the
  // same audited login path immediately after accepting the invite.
  res.json({ success: true, loginRequired: true });
});

router.post('/auth/forgot-password', authRateLimit, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.json({ success: true });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && user.status === 'active') {
    const token = generateToken(32);
    // await cleanupConsumedAuthTokens();
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
      },
    });
    await sendPasswordResetEmail(user.email, token);
    await securityEvent(req, 'password_reset_requested', { userId: user.id });
  }

  res.json({ success: true });
});

router.post('/auth/resend-verification', authRateLimit, async (req: Request, res: Response) => {
  const parsed = resendVerificationSchema.safeParse(req.body);
  if (!parsed.success) return res.json({ success: true });

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, emailVerifiedAt: true, status: true },
  });
  if (user && user.status === 'active' && !user.emailVerifiedAt) {
    await createEmailVerificationToken(user.id, user.email);
    await securityEvent(req, 'email_verification_resent', { userId: user.id });
  }
  return res.json({ success: true });
});

router.post('/auth/reset-password', authRateLimit, async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid reset details' });

  const reset = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(parsed.data.token) },
  });
  if (reset && (reset.usedAt || reset.expiresAt <= new Date())) {
    await prisma.passwordResetToken.delete({ where: { id: reset.id } });
    return res.status(400).json({ error: 'Reset link is invalid or expired' });
  }

  if (!reset) {
    return res.status(400).json({ error: 'Reset link is invalid or expired' });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.delete({ where: { id: reset.id } }),
    prisma.session.updateMany({ where: { userId: reset.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  await securityEvent(req, 'password_reset_completed', { userId: reset.userId });
  res.json({ success: true });
});

router.post('/auth/verify-email', authRateLimit, async (req: Request, res: Response) => {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid verification details' });

  const verify = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(parsed.data.token) },
  });
  if (verify && (verify.usedAt || verify.expiresAt <= new Date())) {
    await prisma.emailVerificationToken.delete({ where: { id: verify.id } });
    return res.status(400).json({ error: 'Verification link is invalid or expired' });
  }

  if (!verify) {
    return res.status(400).json({ error: 'Verification link is invalid or expired' });
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: verify.userId }, data: { emailVerifiedAt: new Date() } }),
    prisma.emailVerificationToken.delete({ where: { id: verify.id } }),
  ]);

  await securityEvent(req, 'email_verified', { userId: verify.userId });
  res.json({ success: true });
});

router.post('/auth/mfa/setup', authRateLimit, requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const [existingMethod, session] = await Promise.all([
    prisma.mfaMethod.findUnique({
      where: { userId_type: { userId: req.auth!.userId, type: 'totp' } },
      select: { enabledAt: true },
    }),
    prisma.session.findUnique({
      where: { id: req.auth!.sessionId },
      select: { mfaVerifiedAt: true },
    }),
  ]);
  if (existingMethod?.enabledAt && !hasFreshMfaVerification(session?.mfaVerifiedAt)) {
    return res.status(403).json({ error: 'MFA re-authentication required', mfaRequired: true });
  }

  const secret = authenticator.generateSecret();
  const serviceName = process.env.APP_NAME ?? 'Dental Receptionist';
  const otpauth = authenticator.keyuri(req.auth!.email, serviceName, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

  await prisma.mfaMethod.upsert({
    where: { userId_type: { userId: req.auth!.userId, type: 'totp' } },
    update: { secret: encryptSecret(secret, `mfa:totp:${req.auth!.userId}`), enabledAt: null },
    create: {
      userId: req.auth!.userId,
      type: 'totp',
      secret: encryptSecret(secret, `mfa:totp:${req.auth!.userId}`),
    },
  });

  res.json({ otpauth, qrCodeDataUrl });
});

router.post('/auth/mfa/verify', authRateLimit, requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid MFA code' });

  const method = await prisma.mfaMethod.findUnique({
    where: { userId_type: { userId: req.auth!.userId, type: 'totp' } },
  });
  if (
    !method?.secret ||
    !authenticator.check(
      parsed.data.code,
      decryptSecret(method.secret, `mfa:totp:${req.auth!.userId}`)
    )
  ) {
    await securityEvent(req, 'mfa_setup_failed', { userId: req.auth!.userId });
    return res.status(400).json({ error: 'Invalid MFA code' });
  }

  const firstEnrollment = !method.enabledAt;
  const recoveryCodes = firstEnrollment
    ? Array.from({ length: 10 }, () => generateToken(8))
    : null;
  if (recoveryCodes) {
    await prisma.mfaMethod.update({
      where: { id: method.id },
      data: {
        enabledAt: new Date(),
        recoveryCodes: recoveryCodes.map(hashToken),
      },
    });
  }

  await prisma.session.update({
    where: { id: req.auth!.sessionId },
    data: { mfaVerifiedAt: new Date() },
  });

  await auditAction(req, firstEnrollment ? 'auth.mfa_enabled' : 'auth.mfa_verified');
  res.json({ success: true, ...(recoveryCodes ? { recoveryCodes } : {}) });
});

export async function createEmailVerificationToken(userId: string, email: string): Promise<void> {
  const token = generateToken(32);
  await cleanupConsumedAuthTokens();
  await prisma.emailVerificationToken.deleteMany({ where: { userId } });
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_HOURS * 60 * 60 * 1000),
    },
  });
  await sendVerifyEmail(email, token);
}

export default router;
