import { prisma } from '../lib/prisma';

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
