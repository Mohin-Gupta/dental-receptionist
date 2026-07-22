import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { clearSessionCookieOptions, SESSION_COOKIE_NAME, SESSION_TTL_DAYS, sessionCookieOptions } from './config';
import { generateToken, hashToken } from './crypto';
import { getRequestMeta } from './audit';

export async function createSession(
  req: Request,
  res: Response,
  userId: string,
  options: { mfaVerified?: boolean } = {}
): Promise<{ csrfToken: string; sessionId: string }> {
  const sessionToken = generateToken(32);
  const csrfToken = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const meta = getRequestMeta(req);

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      mfaVerifiedAt: options.mfaVerified ? new Date() : null,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });

  res.cookie(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions(expiresAt));
  return { csrfToken, sessionId: session.id };
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
