import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { SESSION_COOKIE_NAME } from './config';
import { AuthSelectionError, buildAuthContextForUser } from './context';
import { hashToken, safeTokenEqual } from './crypto';
import { hasPermission } from './permissions';
import type { Permission } from './types';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
  });

  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= new Date()
  ) {
    return res.status(401).json({ error: 'Authentication required' });
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

  prisma.session
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch((err: any) => console.warn('Session lastSeenAt update failed:', err?.message));

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
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ error: 'Webhook authentication is not configured' });
    }
    console.warn('VAPI_WEBHOOK_SECRET not set; allowing webhook in non-production mode.');
    return next();
  }

  const authHeader = req.header('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  const explicit = req.header('x-vapi-secret');
  const supplied = bearer ?? explicit;

  if (!supplied || !safeTokenEqual(hashToken(supplied), hashToken(expected))) {
    return res.status(401).json({ error: 'Invalid webhook authentication' });
  }

  next();
}
