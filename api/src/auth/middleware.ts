import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { SESSION_COOKIE_NAME } from './config';
import { AuthSelectionError, buildAuthContextForUser } from './context';
import { hashToken, safeTokenEqual } from './crypto';
import { hasPermission } from './permissions';
import type { Permission } from './types';
import { acquireTenantRequestLease } from './tenantRateLimit';

const MFA_BOOTSTRAP_PATHS = new Set([
  '/auth/me',
  '/auth/csrf',
  '/auth/mfa/status',
  '/auth/mfa/setup',
  '/auth/mfa/verify',
  '/auth/logout',
  '/auth/logout-all',
]);

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          mfaRequired: true,
          mfaMethods: {
            where: { type: 'totp', enabledAt: { not: null }, secret: { not: null } },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= new Date()
  ) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const isMfaBootstrapRequest = MFA_BOOTSTRAP_PATHS.has(req.path.replace(/\/$/, ''));
  const hasEnabledMfa = session.user.mfaMethods.length > 0;
  if (!isMfaBootstrapRequest && hasEnabledMfa && !session.mfaVerifiedAt) {
    return res.status(403).json({ error: 'MFA verification required', mfaRequired: true });
  }
  if (!isMfaBootstrapRequest && session.user.mfaRequired && !hasEnabledMfa) {
    return res.status(403).json({ error: 'MFA setup required', mfaSetupRequired: true });
  }

  try {
    req.auth = await buildAuthContextForUser(
      session.userId,
      session.id,
      req.header('x-organization-id') ?? undefined,
      req.header('x-clinic-id') ?? undefined
    );
  } catch (err) {
    if (err instanceof AuthSelectionError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  try {
    const allowed = await acquireTenantRequestLease(req.auth.organizationId, res);
    if (!allowed) {
      res.setHeader('Retry-After', res.getHeader('RateLimit-Reset') ?? '60');
      return res.status(429).json({ error: 'This organization is sending too many requests' });
    }
  } catch {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Tenant request controls are temporarily unavailable' });
    }
  }

  const lastSeenCutoff = new Date(Date.now() - 5 * 60 * 1000);
  if (session.lastSeenAt < lastSeenCutoff) {
    prisma.session
      .updateMany({
        where: { id: session.id, lastSeenAt: { lt: lastSeenCutoff } },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => console.warn('Session activity timestamp update failed'));
  }

  next();
}

export function requireClinic(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.clinicId) {
    return res.status(403).json({ error: 'Clinic access required' });
  }
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !hasPermission(req.auth.role, permission)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    next();
  };
}

export function requireOrganizationOwner(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.organizationRole !== 'owner') {
    return res.status(403).json({ error: 'Organization owner access required' });
  }
  return next();
}

/**
 * Sensitive tenant administration must be backed by a fresh MFA verification
 * on this exact session whenever MFA is required or already enabled.
 */
export async function requireMfaForSensitiveAction(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.auth) return res.status(401).json({ error: 'Authentication required' });

  const [user, session] = await Promise.all([
    prisma.user.findUnique({
      where: { id: req.auth.userId },
      select: {
        mfaRequired: true,
        mfaMethods: {
          where: { type: 'totp', enabledAt: { not: null }, secret: { not: null } },
          select: { id: true },
          take: 1,
        },
      },
    }),
    prisma.session.findUnique({
      where: { id: req.auth.sessionId },
      select: { mfaVerifiedAt: true },
    }),
  ]);

  if (!user || !session) return res.status(401).json({ error: 'Authentication required' });
  if (user.mfaMethods.length === 0) {
    return res.status(403).json({ error: 'MFA setup required', mfaSetupRequired: true });
  }
  if (!hasFreshMfaVerification(session.mfaVerifiedAt)) {
    return res.status(403).json({ error: 'MFA re-authentication required', mfaRequired: true });
  }
  return next();
}

export function hasFreshMfaVerification(verifiedAt: Date | null | undefined): boolean {
  const configuredMinutes = Number(process.env.MFA_SENSITIVE_WINDOW_MINUTES ?? '30');
  const windowMinutes = Number.isFinite(configuredMinutes) && configuredMinutes > 0
    ? Math.min(configuredMinutes, 24 * 60)
    : 30;
  return Boolean(verifiedAt && verifiedAt.getTime() >= Date.now() - windowMinutes * 60 * 1000);
}

export async function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.auth?.sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const csrfToken = req.header('x-csrf-token');
  if (!csrfToken) {
    return res.status(403).json({ error: 'CSRF token required' });
  }

  const session = await prisma.session.findUnique({
    where: { id: req.auth.sessionId },
    select: { csrfTokenHash: true },
  });

  const suppliedHash = hashToken(csrfToken);
  if (!session?.csrfTokenHash || !safeTokenEqual(session.csrfTokenHash, suppliedHash)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  next();
}

export function requireMachineAuth(req: Request, res: Response, next: NextFunction) {
  const hmacSecret = process.env.VAPI_HMAC_SECRET;
  if (hmacSecret) {
    const signatureHeader = (process.env.VAPI_HMAC_SIGNATURE_HEADER ?? 'x-vapi-signature').toLowerCase();
    const timestampHeader = (process.env.VAPI_HMAC_TIMESTAMP_HEADER ?? 'x-vapi-timestamp').toLowerCase();
    const signature = req.header(signatureHeader);
    const timestamp = req.header(timestampHeader);

    if (!signature || !timestamp || !req.rawBody) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const rawTimestamp = Number(timestamp);
    const timestampMs = rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
    const toleranceMs = Number(process.env.VAPI_HMAC_TOLERANCE_SECONDS ?? '300') * 1000;

    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > toleranceMs) {
      return res.status(401).json({ error: 'Webhook timestamp outside replay window' });
    }

    // Configure the Vapi Custom Credential payload format as
    // `<timestamp>.<raw request body>` to match this verifier.
    const signedPayload = Buffer.concat([
      Buffer.from(`${timestamp}.`, 'utf8'),
      req.rawBody,
    ]);
    const digest = crypto.createHmac('sha256', hmacSecret).update(signedPayload).digest();
    const supplied = signature.replace(/^sha256=/i, '').trim();
    const candidates = [digest.toString('hex'), digest.toString('base64')];

    if (!candidates.some((candidate) => safeTokenEqual(candidate, supplied))) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    req.machineAuth = { provider: 'vapi', method: 'hmac' };
    return next();
  }

  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ error: 'Webhook authentication is not configured' });
    }
    console.warn('VAPI_WEBHOOK_SECRET not set; allowing webhook in non-production mode.');
    req.machineAuth = { provider: 'vapi', method: 'development' };
    return next();
  }

  const authHeader = req.header('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  const explicit = req.header('x-vapi-secret');
  const supplied = bearer ?? explicit;

  if (!supplied || !safeTokenEqual(hashToken(supplied), hashToken(expected))) {
    return res.status(401).json({ error: 'Invalid webhook authentication' });
  }

  req.machineAuth = { provider: 'vapi', method: 'bearer' };
  next();
}
