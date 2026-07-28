import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { clearSessionCookieOptions, SESSION_COOKIE_NAME, SESSION_TTL_DAYS, sessionCookieOptions } from './config';
import { generateToken, hashToken } from './crypto';
import { getRequestMeta } from './audit';

export type MfaVerificationMethod = 'totp' | 'recovery_code';

export interface CreatedSession {
  csrfToken: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: Date;
}

type SessionWriter = Pick<Prisma.TransactionClient, 'session'>;

/**
 * Persists a session without touching response headers. Keeping persistence
 * separate lets a recovery code and its resulting session commit atomically;
 * the cookie is only attached after the transaction succeeds.
 */
export async function createSessionRecord(
  req: Request,
  userId: string,
  options: { mfaVerifiedMethod?: MfaVerificationMethod } = {},
  db: SessionWriter = prisma
): Promise<CreatedSession> {
  const sessionToken = generateToken(32);
  const csrfToken = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const meta = getRequestMeta(req);

  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      mfaVerifiedAt: options.mfaVerifiedMethod ? new Date() : null,
      mfaVerifiedMethod: options.mfaVerifiedMethod ?? null,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });

  return { csrfToken, sessionId: session.id, sessionToken, expiresAt };
}

export function setSessionCookie(res: Response, session: CreatedSession): void {
  res.cookie(SESSION_COOKIE_NAME, session.sessionToken, sessionCookieOptions(session.expiresAt));
}

export function clearSessionCookie(res: Response): void {
  res.cookie(SESSION_COOKIE_NAME, '', clearSessionCookieOptions());
}

export async function rotateCsrfToken(sessionId: string): Promise<string> {
  const csrfToken = generateToken(32);
  await prisma.session.update({
    where: { id: sessionId },
    data: { csrfTokenHash: hashToken(csrfToken) },
  });
  return csrfToken;
}
