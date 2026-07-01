import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma';
import { auditAction, securityEvent } from '../auth/audit';
import { EMAIL_VERIFY_TTL_HOURS, INVITE_TTL_HOURS, PASSWORD_RESET_TTL_MINUTES } from '../auth/config';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../auth/crypto';
import { requireAuth, requireClinic, requireCsrf, requirePermission } from '../auth/middleware';
import { authRateLimit } from '../auth/rateLimit';
import { clearSessionCookie, createSession, rotateCsrfToken } from '../auth/sessions';
import { sendInviteEmail, sendPasswordResetEmail, sendVerifyEmail } from '../auth/mailer';
import { isAuthRole } from '../auth/permissions';

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
  role: z.enum(['owner', 'admin', 'staff', 'viewer']).default('staff'),
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

function publicAuth(req: Request) {
  return {
    user: {
      id: req.auth!.userId,
      email: req.auth!.email,
      name: req.auth!.name,
    },
    activeClinic: {
      id: req.auth!.clinicId,
      role: req.auth!.role,
    },
    memberships: req.auth!.memberships,
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
    include: { mfaMethods: true, memberships: true },
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

  const { csrfToken } = await createSession(req, res, user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
  await auditAction(req, 'auth.login', { userId: user.id });

  const authReq = {
    ...req,
    auth: {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: isAuthRole(user.memberships[0]?.role ?? '') ? user.memberships[0].role : 'viewer',
      clinicId: user.memberships[0]?.clinicId ?? '',
      memberships: user.memberships
        .filter((m) => isAuthRole(m.role))
        .map((m) => ({ clinicId: m.clinicId, role: m.role as any })),
      sessionId: '',
    },
  } as Request;

  res.json({ ...publicAuth(authReq), csrfToken });
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
  res.json(publicAuth(req));
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

    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    const invite = await prisma.inviteToken.create({
      data: {
        clinicId: req.auth!.clinicId,
        email: parsed.data.email,
        role: parsed.data.role,
        tokenHash: hashToken(token),
        expiresAt,
        createdById: req.auth!.userId,
      },
    });

    await sendInviteEmail(parsed.data.email, token);
    await auditAction(req, 'auth.invite_created', {
      targetType: 'InviteToken',
      targetId: invite.id,
      metadata: { email: parsed.data.email, role: parsed.data.role },
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

  if (!invite || invite.acceptedAt || invite.expiresAt <= new Date()) {
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

    await tx.clinicMembership.upsert({
      where: { userId_clinicId: { userId: account.id, clinicId: invite.clinicId } },
      update: { role: invite.role },
      create: { userId: account.id, clinicId: invite.clinicId, role: invite.role },
    });

    await tx.inviteToken.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedById: account.id },
    });

    return account;
  });

  const { csrfToken } = await createSession(req, res, user.id);
  await auditAction(req, 'auth.invite_accepted', {
    userId: user.id,
    clinicId: invite.clinicId,
    targetType: 'InviteToken',
    targetId: invite.id,
  });

  res.json({ success: true, csrfToken });
});

router.post('/auth/forgot-password', authRateLimit, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.json({ success: true });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && user.status === 'active') {
    const token = generateToken(32);
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
  if (!reset || reset.usedAt || reset.expiresAt <= new Date()) {
    return res.status(400).json({ error: 'Reset link is invalid or expired' });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
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
  if (!verify || verify.usedAt || verify.expiresAt <= new Date()) {
    return res.status(400).json({ error: 'Verification link is invalid or expired' });
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: verify.userId }, data: { emailVerifiedAt: new Date() } }),
    prisma.emailVerificationToken.update({ where: { id: verify.id }, data: { usedAt: new Date() } }),
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
