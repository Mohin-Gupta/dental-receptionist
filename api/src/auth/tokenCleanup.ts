import { prisma } from '../lib/prisma';
import { cleanupExpiredMfaEnrollmentChallenges } from './mfaService';

export async function cleanupConsumedAuthTokens() {
  const now = new Date();

  await prisma.$transaction([
    prisma.inviteToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { acceptedAt: { not: null } },
        ],
      },
    }),
    prisma.passwordResetToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { usedAt: { not: null } },
        ],
      },
    }),
    prisma.emailVerificationToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { usedAt: { not: null } },
        ],
      },
    }),
  ]);
}

/** Worker-only cleanup; keep the per-user MFA lock loop off request latency. */
export async function cleanupExpiredAuthenticationState() {
  const now = new Date();
  await cleanupConsumedAuthTokens();
  await cleanupExpiredMfaEnrollmentChallenges(250, now);
}
