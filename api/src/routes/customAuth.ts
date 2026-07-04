import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma';
import { auditAction, getRequestMeta, securityEvent } from '../auth/audit';
import { EMAIL_VERIFY_TTL_HOURS, INVITE_TTL_HOURS, PASSWORD_RESET_TTL_MINUTES } from '../auth/config';
import { AuthSelectionError, buildAuthContextForUser } from '../auth/context';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../auth/crypto';
import { requireAuth, requireClinic, requireCsrf, requirePermission } from '../auth/middleware';
import { authRateLimit } from '../auth/rateLimit';
import { clearSessionCookie, createSession, rotateCsrfToken } from '../auth/sessions';
import { sendInviteEmail, sendPasswordResetEmail, sendVerifyEmail } from '../auth/mailer';
import { cleanupConsumedAuthTokens } from '../auth/tokenCleanup';
import type { AuthContext } from '../auth/types';

const router = Router();

const emailSchema = z.string().email().transform((v) => v.trim().toLowerCase());
const passwordSchema = z.string().min(12).max(200);

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  totpCode: z.string().trim().min(6).max(10).optional(),
});

const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(['owner', 'admin', 'staff', 'viewer']).optional(),
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

const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});

const verifyEmailSchema = z.object({ token: z.string().min(20) });

const mfaVerifySchema = z.object({ code: z.string().trim().min(6).max(10) });

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

  const totp = user.mfaMethods.find((m) => m.type === 'totp' && m.enabledAt && m.secret);
  if (totp) {
    if (!parsed.data.totpCode) {
      await securityEvent(req, 'mfa_required', { userId: user.id });
      return res.status(202).json({ mfaRequired: true });
    }

    const validTotp = authenticator.check(parsed.data.totpCode, totp.secret!);
    if (!validTotp) {
      await securityEvent(req, 'mfa_failed', { userId: user.id });
      return res.status(401).json({ error: 'Invalid MFA code' });
    }
  }

  const meta = getRequestMeta(req);
  if (meta.ipAddress) {
    const activeSessionFromIp = await prisma.session.findFirst({
      where: {
        userId: user.id,
        ipAddress: meta.ipAddress,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (activeSessionFromIp) {
      await securityEvent(req, 'login_blocked_active_session', {
        userId: user.id,
        metadata: {
          ipAddress: meta.ipAddress,
          sessionId: activeSessionFromIp.id,
        },
      });
      return res.status(409).json({
        error: 'An active session already exists from this IP. Please log out first.',
      });
    }
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

  const { csrfToken, sessionId } = await createSession(req, res, user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
  await auditAction(req, 'auth.login', { userId: user.id });

  res.json({ ...publicAuth({ ...initialAuth, sessionId }), csrfToken });
});

router.post('/auth/logout', requireAuth, async (req: Request, res: Response) => {
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

router.post(
  '/auth/invites',
  requireAuth,
  requireClinic,
  requireCsrf,
  requirePermission('users:manage'),
  async (req: Request, res: Response) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid invite details' });

    const requestedRole = parsed.data.role;
    const organizationRole =
      parsed.data.organizationRole ??
      (requestedRole === 'owner' ? 'owner' : undefined);
    const clinicRole =
      parsed.data.clinicRole ??
      (requestedRole && requestedRole !== 'owner' ? requestedRole : undefined) ??
      (!organizationRole ? 'staff' : undefined);
    const clinicId = clinicRole ? (parsed.data.clinicId ?? req.auth!.clinicId) : undefined;

    if (!organizationRole && !clinicRole) {
      return res.status(400).json({ error: 'Invite must include an organization or clinic role' });
    }

    if (clinicId && !req.auth!.clinics.some((clinic) => clinic.id === clinicId)) {
      return res.status(403).json({ error: 'Clinic access denied' });
    }

    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    await cleanupConsumedAuthTokens();
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
        role: requestedRole ?? clinicRole ?? organizationRole ?? 'staff',
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

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: invite.email } });
    const account =
      existing ??
      (await tx.user.create({
        data: {
          email: invite.email,
          name: parsed.data.name,
          passwordHash,
          emailVerifiedAt: new Date(),
          status: 'active',
        },
      }));

    if (existing && !existing.emailVerifiedAt) {
      await tx.user.update({
        where: { id: existing.id },
        data: { emailVerifiedAt: new Date(), name: existing.name || parsed.data.name },
      });
    }

    if (invite.organizationRole) {
      await tx.organizationMembership.upsert({
        where: {
          userId_organizationId: {
            userId: account.id,
            organizationId: invite.organizationId,
          },
        },
        update: { role: invite.organizationRole },
        create: {
          userId: account.id,
          organizationId: invite.organizationId,
          role: invite.organizationRole,
        },
      });
    }

    if (invite.clinicId && invite.clinicRole) {
      await tx.clinicMembership.upsert({
        where: { userId_clinicId: { userId: account.id, clinicId: invite.clinicId } },
        update: { role: invite.clinicRole },
        create: { userId: account.id, clinicId: invite.clinicId, role: invite.clinicRole },
      });
    }

    await tx.inviteToken.delete({
      where: { id: invite.id },
    });

    return account;
  });

  const { csrfToken, sessionId } = await createSession(req, res, user.id);
  const auth = await buildAuthContextForUser(user.id, sessionId, invite.organizationId, invite.clinicId ?? undefined);
  await auditAction(req, 'auth.invite_accepted', {
    userId: user.id,
    organizationId: invite.organizationId,
    clinicId: invite.clinicId,
    targetType: 'InviteToken',
    targetId: invite.id,
  });

  res.json({ success: true, ...publicAuth(auth), csrfToken });
});

router.post('/auth/forgot-password', authRateLimit, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.json({ success: true });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && user.status === 'active') {
    const token = generateToken(32);
    await cleanupConsumedAuthTokens();
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

router.post('/auth/mfa/setup', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const secret = authenticator.generateSecret();
  const serviceName = process.env.APP_NAME ?? 'Dental Receptionist';
  const otpauth = authenticator.keyuri(req.auth!.email, serviceName, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

  await prisma.mfaMethod.upsert({
    where: { id: (await prisma.mfaMethod.findFirst({ where: { userId: req.auth!.userId, type: 'totp' } }))?.id ?? '' },
    update: { secret, enabledAt: null },
    create: { userId: req.auth!.userId, type: 'totp', secret },
  }).catch(async () => {
    await prisma.mfaMethod.create({ data: { userId: req.auth!.userId, type: 'totp', secret } });
  });

  res.json({ otpauth, qrCodeDataUrl });
});

router.post('/auth/mfa/verify', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid MFA code' });

  const method = await prisma.mfaMethod.findFirst({
    where: { userId: req.auth!.userId, type: 'totp', secret: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  if (!method?.secret || !authenticator.check(parsed.data.code, method.secret)) {
    await securityEvent(req, 'mfa_setup_failed', { userId: req.auth!.userId });
    return res.status(400).json({ error: 'Invalid MFA code' });
  }

  const recoveryCodes = Array.from({ length: 10 }, () => generateToken(8));
  await prisma.mfaMethod.update({
    where: { id: method.id },
    data: {
      enabledAt: new Date(),
      recoveryCodes: recoveryCodes.map(hashToken),
    },
  });

  await auditAction(req, 'auth.mfa_enabled');
  res.json({ success: true, recoveryCodes });
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
