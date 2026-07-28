import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { authenticator } from 'otplib';
import { prisma } from '../lib/prisma';
import { generateToken, hashToken, safeTokenEqual, verifyPassword } from './crypto';
import { decryptSecret, encryptSecret } from './secretBox';

export type MfaEnrollmentPurpose = 'enroll' | 'replace';

export interface MfaEventContext {
  userId: string;
  sessionId: string;
  organizationId?: string | null;
  clinicId?: string | null;
  ipAddress?: string;
  userAgent?: string;
}

export class MfaServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 16;
const MAX_ENROLLMENT_ATTEMPTS = 5;

function enrollmentTtlMinutes(): number {
  const configured = Number(process.env.MFA_ENROLLMENT_TTL_MINUTES ?? '10');
  return Number.isInteger(configured) && configured >= 5 && configured <= 30
    ? configured
    : 10;
}

function sensitiveWindowMinutes(): number {
  const configured = Number(process.env.MFA_SENSITIVE_WINDOW_MINUTES ?? '30');
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 24 * 60)
    : 30;
}

export function hasFreshMfaTimestamp(value: Date | null | undefined, now = new Date()): boolean {
  return Boolean(
    value && value.getTime() >= now.getTime() - sensitiveWindowMinutes() * 60 * 1000
  );
}

export function recoveryCodeHashes(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function recoveryCodesRemaining(value: Prisma.JsonValue | null | undefined): number {
  return recoveryCodeHashes(value).length;
}

export function recoveryCodeMatches(
  value: Prisma.JsonValue | null | undefined,
  suppliedCode: string
): boolean {
  const suppliedHash = hashToken(suppliedCode);
  return recoveryCodeHashes(value).some(storedHash => safeTokenEqual(storedHash, suppliedHash));
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => generateToken(RECOVERY_CODE_BYTES));
}

function activeSecretPurpose(userId: string): string {
  return `mfa:totp:${userId}`;
}

function pendingSecretPurpose(userId: string, enrollmentId: string): string {
  return `mfa:totp-pending:${userId}:${enrollmentId}`;
}

async function lockMfa(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa:${userId}`}, 0))`;
}

function auditData(
  context: MfaEventContext,
  action: string,
  metadata?: Prisma.InputJsonObject
): Prisma.AuditLogUncheckedCreateInput {
  return {
    userId: context.userId,
    organizationId: context.organizationId ?? null,
    clinicId: context.clinicId ?? null,
    action,
    targetType: 'User',
    targetId: context.userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  };
}

function securityData(
  context: MfaEventContext,
  type: string,
  metadata?: Prisma.InputJsonObject
): Prisma.SecurityEventUncheckedCreateInput {
  return {
    userId: context.userId,
    organizationId: context.organizationId ?? null,
    clinicId: context.clinicId ?? null,
    type,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  };
}

async function passwordSnapshot(userId: string, password: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, status: true },
  });
  if (!user || user.status !== 'active' || !(await verifyPassword(user.passwordHash, password))) {
    // The login session is still valid; this is confirmation-field validation,
    // not an authentication failure that should redirect the browser to login.
    throw new MfaServiceError(400, 'invalid_password', 'Current password is incorrect');
  }
  return user.passwordHash;
}

export async function startMfaEnrollment(input: {
  context: MfaEventContext;
  password: string;
  purpose: MfaEnrollmentPurpose;
}): Promise<{ enrollmentId: string; secret: string; expiresAt: Date }> {
  const expectedPasswordHash = await passwordSnapshot(input.context.userId, input.password);
  const enrollmentId = crypto.randomUUID();
  const secret = authenticator.generateSecret();
  const encryptedSecret = encryptSecret(
    secret,
    pendingSecretPurpose(input.context.userId, enrollmentId)
  );

  const expiresAt = await prisma.$transaction(async tx => {
    await lockMfa(tx, input.context.userId);
    const now = new Date();
    const challengeExpiresAt = new Date(
      now.getTime() + enrollmentTtlMinutes() * 60 * 1000
    );
    const [user, session, method] = await Promise.all([
      tx.user.findUnique({
        where: { id: input.context.userId },
        select: { passwordHash: true, status: true },
      }),
      tx.session.findFirst({
        where: {
          id: input.context.sessionId,
          userId: input.context.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { mfaVerifiedAt: true, mfaVerifiedMethod: true },
      }),
      tx.mfaMethod.findUnique({
        where: { userId_type: { userId: input.context.userId, type: 'totp' } },
        select: { enabledAt: true, secret: true },
      }),
    ]);
    if (!user || user.status !== 'active' || user.passwordHash !== expectedPasswordHash || !session) {
      throw new MfaServiceError(401, 'authentication_changed', 'Authentication must be repeated');
    }

    const enabled = Boolean(method?.enabledAt && method.secret);
    if (input.purpose === 'enroll' && enabled) {
      throw new MfaServiceError(409, 'mfa_already_enabled', 'MFA is already enabled');
    }
    if (input.purpose === 'replace' && !enabled) {
      throw new MfaServiceError(409, 'mfa_not_enabled', 'There is no active authenticator to replace');
    }
    if (
      input.purpose === 'replace' &&
      !hasFreshMfaTimestamp(session.mfaVerifiedAt, now)
    ) {
      throw new MfaServiceError(403, 'mfa_reauthentication_required', 'MFA re-authentication required');
    }

    const activeSession = await tx.session.updateMany({
      where: {
        id: input.context.sessionId,
        userId: input.context.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { lastSeenAt: now },
    });
    if (activeSession.count !== 1) {
      throw new MfaServiceError(401, 'authentication_changed', 'Authentication must be repeated');
    }

    await tx.mfaEnrollmentChallenge.deleteMany({ where: { userId: input.context.userId } });
    await tx.mfaEnrollmentChallenge.create({
      data: {
        id: enrollmentId,
        userId: input.context.userId,
        sessionId: input.context.sessionId,
        purpose: input.purpose,
        secret: encryptedSecret,
        expiresAt: challengeExpiresAt,
      },
    });
    await tx.auditLog.create({
      data: auditData(input.context, 'auth.mfa_enrollment_started', {
        enrollmentId,
        purpose: input.purpose,
        expiresAt: challengeExpiresAt.toISOString(),
      }),
    });
    return challengeExpiresAt;
  });

  return { enrollmentId, secret, expiresAt };
}

type EnrollmentVerificationResult =
  | { kind: 'success'; purpose: MfaEnrollmentPurpose; recoveryCodes: string[] }
  | { kind: 'missing' | 'expired' | 'exhausted' | 'invalid' | 'authentication_changed' };

export async function verifyMfaEnrollment(input: {
  context: MfaEventContext;
  enrollmentId: string;
  code: string;
}): Promise<{ purpose: MfaEnrollmentPurpose; recoveryCodes: string[] }> {
  const recoveryCodes = generateRecoveryCodes();

  const result = await prisma.$transaction<EnrollmentVerificationResult>(async tx => {
    await lockMfa(tx, input.context.userId);
    const now = new Date();
    const [challenge, session] = await Promise.all([
      tx.mfaEnrollmentChallenge.findFirst({
        where: {
          id: input.enrollmentId,
          userId: input.context.userId,
          sessionId: input.context.sessionId,
        },
      }),
      tx.session.findFirst({
        where: {
          id: input.context.sessionId,
          userId: input.context.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      }),
    ]);
    if (!session) return { kind: 'authentication_changed' };
    if (!challenge) return { kind: 'missing' };
    if (challenge.expiresAt <= now) {
      await tx.mfaEnrollmentChallenge.delete({ where: { id: challenge.id } });
      return { kind: 'expired' };
    }
    if (challenge.attemptCount >= MAX_ENROLLMENT_ATTEMPTS) {
      await tx.mfaEnrollmentChallenge.delete({ where: { id: challenge.id } });
      return { kind: 'exhausted' };
    }

    const secret = decryptSecret(
      challenge.secret,
      pendingSecretPurpose(input.context.userId, challenge.id)
    );
    if (!authenticator.check(input.code, secret)) {
      const nextAttemptCount = challenge.attemptCount + 1;
      if (nextAttemptCount >= MAX_ENROLLMENT_ATTEMPTS) {
        await tx.mfaEnrollmentChallenge.delete({ where: { id: challenge.id } });
      } else {
        await tx.mfaEnrollmentChallenge.update({
          where: { id: challenge.id },
          data: { attemptCount: nextAttemptCount },
        });
      }
      await tx.securityEvent.create({
        data: securityData(input.context, 'mfa_enrollment_verification_failed', {
          enrollmentId: challenge.id,
          purpose: challenge.purpose,
          attemptsRemaining: Math.max(0, MAX_ENROLLMENT_ATTEMPTS - nextAttemptCount),
        }),
      });
      return { kind: nextAttemptCount >= MAX_ENROLLMENT_ATTEMPTS ? 'exhausted' : 'invalid' };
    }

    const purpose = challenge.purpose as MfaEnrollmentPurpose;
    const activeSecret = encryptSecret(secret, activeSecretPurpose(input.context.userId));
    const activeSession = await tx.session.updateMany({
      where: {
        id: input.context.sessionId,
        userId: input.context.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { mfaVerifiedAt: now, mfaVerifiedMethod: 'totp' },
    });
    if (activeSession.count !== 1) return { kind: 'authentication_changed' };

    await tx.mfaMethod.upsert({
      where: { userId_type: { userId: input.context.userId, type: 'totp' } },
      create: {
        userId: input.context.userId,
        type: 'totp',
        secret: activeSecret,
        enabledAt: now,
        recoveryCodes: recoveryCodes.map(hashToken),
        recoveryCodesGeneratedAt: now,
      },
      update: {
        secret: activeSecret,
        enabledAt: now,
        recoveryCodes: recoveryCodes.map(hashToken),
        recoveryCodesGeneratedAt: now,
        version: { increment: 1 },
      },
    });
    await tx.mfaEnrollmentChallenge.delete({ where: { id: challenge.id } });
    await tx.auditLog.create({
      data: auditData(
        input.context,
        purpose === 'replace' ? 'auth.mfa_replaced' : 'auth.mfa_enabled',
        { enrollmentId: challenge.id }
      ),
    });
    return { kind: 'success', purpose, recoveryCodes };
  });

  if (result.kind === 'success') return result;
  if (result.kind === 'expired') {
    throw new MfaServiceError(410, 'mfa_enrollment_expired', 'MFA setup has expired; start again');
  }
  if (result.kind === 'exhausted') {
    throw new MfaServiceError(429, 'mfa_enrollment_exhausted', 'Too many invalid codes; start again');
  }
  if (result.kind === 'invalid') {
    throw new MfaServiceError(400, 'invalid_mfa_code', 'Invalid MFA code');
  }
  if (result.kind === 'authentication_changed') {
    throw new MfaServiceError(401, 'authentication_changed', 'Authentication must be repeated');
  }
  throw new MfaServiceError(404, 'mfa_enrollment_not_found', 'MFA setup was not found for this session');
}

export async function verifyCurrentMfa(input: {
  context: MfaEventContext;
  code: string;
}): Promise<void> {
  const outcome = await prisma.$transaction(async tx => {
    await lockMfa(tx, input.context.userId);
    const now = new Date();
    const [method, session] = await Promise.all([
      tx.mfaMethod.findUnique({
        where: { userId_type: { userId: input.context.userId, type: 'totp' } },
        select: { secret: true, enabledAt: true },
      }),
      tx.session.findFirst({
        where: {
          id: input.context.sessionId,
          userId: input.context.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      }),
    ]);
    if (!session) return 'authentication_changed' as const;
    if (
      !method?.secret ||
      !method.enabledAt ||
      !authenticator.check(input.code, decryptSecret(method.secret, activeSecretPurpose(input.context.userId)))
    ) {
      await tx.securityEvent.create({
        data: securityData(input.context, 'mfa_failed'),
      });
      return 'invalid' as const;
    }
    const activeSession = await tx.session.updateMany({
      where: {
        id: input.context.sessionId,
        userId: input.context.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { mfaVerifiedAt: now, mfaVerifiedMethod: 'totp' },
    });
    if (activeSession.count !== 1) return 'authentication_changed' as const;
    await tx.auditLog.create({ data: auditData(input.context, 'auth.mfa_verified') });
    return 'success' as const;
  });
  if (outcome === 'invalid') {
    throw new MfaServiceError(400, 'invalid_mfa_code', 'Invalid MFA code');
  }
  if (outcome === 'authentication_changed') {
    throw new MfaServiceError(401, 'authentication_changed', 'Authentication must be repeated');
  }
}

export async function cancelMfaEnrollment(context: MfaEventContext, enrollmentId: string) {
  const removed = await prisma.$transaction(async tx => {
    await lockMfa(tx, context.userId);
    const deleted = await tx.mfaEnrollmentChallenge.deleteMany({
      where: { id: enrollmentId, userId: context.userId, sessionId: context.sessionId },
    });
    if (deleted.count > 0) {
      await tx.auditLog.create({
        data: auditData(context, 'auth.mfa_enrollment_cancelled', { enrollmentId }),
      });
    }
    return deleted.count;
  });
  if (removed === 0) {
    throw new MfaServiceError(404, 'mfa_enrollment_not_found', 'MFA setup was not found for this session');
  }
}

export async function regenerateRecoveryCodes(input: {
  context: MfaEventContext;
  password: string;
  code: string;
}): Promise<string[]> {
  const expectedPasswordHash = await passwordSnapshot(input.context.userId, input.password);
  const snapshot = await prisma.mfaMethod.findUnique({
    where: { userId_type: { userId: input.context.userId, type: 'totp' } },
    select: { version: true },
  });
  if (!snapshot) throw new MfaServiceError(409, 'mfa_not_enabled', 'MFA is not enabled');

  const recoveryCodes = generateRecoveryCodes();
  const outcome = await prisma.$transaction(async tx => {
    await lockMfa(tx, input.context.userId);
    const now = new Date();
    const [user, method, session] = await Promise.all([
      tx.user.findUnique({
        where: { id: input.context.userId },
        select: { passwordHash: true, status: true },
      }),
      tx.mfaMethod.findUnique({
        where: { userId_type: { userId: input.context.userId, type: 'totp' } },
      }),
      tx.session.findFirst({
        where: {
          id: input.context.sessionId,
          userId: input.context.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      }),
    ]);
    if (
      !user ||
      user.status !== 'active' ||
      user.passwordHash !== expectedPasswordHash ||
      !session
    ) return 'authentication_changed' as const;
    if (!method?.enabledAt || !method.secret) return 'missing' as const;
    if (method.version !== snapshot.version) return 'conflict' as const;
    if (!authenticator.check(input.code, decryptSecret(method.secret, activeSecretPurpose(input.context.userId)))) {
      await tx.securityEvent.create({
        data: securityData(input.context, 'mfa_recovery_codes_regeneration_failed'),
      });
      return 'invalid' as const;
    }
    const activeSession = await tx.session.updateMany({
      where: {
        id: input.context.sessionId,
        userId: input.context.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { mfaVerifiedAt: now, mfaVerifiedMethod: 'totp' },
    });
    if (activeSession.count !== 1) return 'authentication_changed' as const;

    await tx.mfaMethod.update({
      where: { id: method.id },
      data: {
        recoveryCodes: recoveryCodes.map(hashToken),
        recoveryCodesGeneratedAt: now,
        version: { increment: 1 },
      },
    });
    await tx.auditLog.create({
      data: auditData(input.context, 'auth.mfa_recovery_codes_regenerated'),
    });
    return 'success' as const;
  });

  if (outcome === 'success') return recoveryCodes;
  if (outcome === 'conflict') {
    throw new MfaServiceError(409, 'mfa_state_changed', 'MFA state changed; retry the request');
  }
  if (outcome === 'invalid') {
    throw new MfaServiceError(400, 'invalid_mfa_code', 'Invalid MFA code');
  }
  if (outcome === 'authentication_changed') {
    throw new MfaServiceError(401, 'authentication_changed', 'Authentication must be repeated');
  }
  throw new MfaServiceError(409, 'mfa_not_enabled', 'MFA is not enabled');
}

export async function disableMfa(input: {
  context: MfaEventContext;
  password: string;
  code: string;
}): Promise<number> {
  const expectedPasswordHash = await passwordSnapshot(input.context.userId, input.password);
  const outcome = await prisma.$transaction(async tx => {
    await lockMfa(tx, input.context.userId);
    const now = new Date();
    const [user, method, session] = await Promise.all([
      tx.user.findUnique({
        where: { id: input.context.userId },
        select: {
          passwordHash: true,
          status: true,
          mfaRequired: true,
          organizationMemberships: { where: { role: 'owner' }, select: { id: true }, take: 1 },
          memberships: { where: { role: 'owner' }, select: { id: true }, take: 1 },
        },
      }),
      tx.mfaMethod.findUnique({
        where: { userId_type: { userId: input.context.userId, type: 'totp' } },
      }),
      tx.session.findFirst({
        where: {
          id: input.context.sessionId,
          userId: input.context.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      }),
    ]);
    if (
      !user ||
      user.status !== 'active' ||
      user.passwordHash !== expectedPasswordHash ||
      !session
    ) {
      return { kind: 'authentication_changed' } as const;
    }
    if (user.mfaRequired || user.organizationMemberships.length > 0 || user.memberships.length > 0) {
      return { kind: 'required' } as const;
    }
    if (!method?.enabledAt || !method.secret) return { kind: 'missing' } as const;
    if (!authenticator.check(input.code, decryptSecret(method.secret, activeSecretPurpose(input.context.userId)))) {
      await tx.securityEvent.create({ data: securityData(input.context, 'mfa_disable_failed') });
      return { kind: 'invalid' } as const;
    }

    const activeSession = await tx.session.updateMany({
      where: {
        id: input.context.sessionId,
        userId: input.context.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { mfaVerifiedAt: now, mfaVerifiedMethod: 'totp' },
    });
    if (activeSession.count !== 1) return { kind: 'authentication_changed' } as const;

    await tx.mfaEnrollmentChallenge.deleteMany({ where: { userId: input.context.userId } });
    await tx.mfaMethod.delete({ where: { id: method.id } });
    const revoked = await tx.session.updateMany({
      where: { userId: input.context.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.auditLog.create({
      data: auditData(input.context, 'auth.mfa_disabled', { revokedSessions: revoked.count }),
    });
    return { kind: 'success', revoked: revoked.count } as const;
  });

  if (outcome.kind === 'success') return outcome.revoked;
  if (outcome.kind === 'required') {
    throw new MfaServiceError(409, 'mfa_required_by_policy', 'MFA is required for this account');
  }
  if (outcome.kind === 'invalid') {
    throw new MfaServiceError(400, 'invalid_mfa_code', 'Invalid MFA code');
  }
  if (outcome.kind === 'authentication_changed') {
    throw new MfaServiceError(401, 'authentication_changed', 'Authentication must be repeated');
  }
  throw new MfaServiceError(409, 'mfa_not_enabled', 'MFA is not enabled');
}

export async function revokeOtherSessions(context: MfaEventContext): Promise<number> {
  return prisma.$transaction(async tx => {
    await lockMfa(tx, context.userId);
    const now = new Date();
    const session = await tx.session.findFirst({
      where: {
        id: context.sessionId,
        userId: context.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { mfaVerifiedAt: true, mfaVerifiedMethod: true },
    });
    if (!session || !hasFreshMfaTimestamp(session.mfaVerifiedAt, now)) {
      throw new MfaServiceError(403, 'mfa_reauthentication_required', 'MFA re-authentication required');
    }
    const activeSession = await tx.session.updateMany({
      where: {
        id: context.sessionId,
        userId: context.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { lastSeenAt: now },
    });
    if (activeSession.count !== 1) {
      throw new MfaServiceError(401, 'authentication_changed', 'Authentication must be repeated');
    }
    const revoked = await tx.session.updateMany({
      where: {
        userId: context.userId,
        id: { not: context.sessionId },
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    await tx.auditLog.create({
      data: auditData(context, 'auth.sessions_revoked_others', { revokedSessions: revoked.count }),
    });
    return revoked.count;
  });
}

/**
 * Deletes abandoned challenges without racing activation. Every MFA mutation
 * and this cleanup path take the same per-user transaction lock.
 */
export async function cleanupExpiredMfaEnrollmentChallenges(
  limit = 250,
  now = new Date()
): Promise<number> {
  const expired = await prisma.mfaEnrollmentChallenge.findMany({
    where: { expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: limit,
    select: { id: true, userId: true },
  });

  let removed = 0;
  for (const challenge of expired) {
    removed += await prisma.$transaction(async tx => {
      await lockMfa(tx, challenge.userId);
      const deleted = await tx.mfaEnrollmentChallenge.deleteMany({
        where: {
          id: challenge.id,
          userId: challenge.userId,
          expiresAt: { lte: now },
        },
      });
      return deleted.count;
    });
  }
  return removed;
}
