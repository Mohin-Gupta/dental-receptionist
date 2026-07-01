import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.AUTH_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.AUTH_BOOTSTRAP_PASSWORD;
  const name = process.env.AUTH_BOOTSTRAP_NAME?.trim() || 'Clinic Owner';
  const clinicId = process.env.AUTH_BOOTSTRAP_CLINIC_ID || process.env.DEFAULT_CLINIC_ID;

  if (!email || !password || !clinicId) {
    throw new Error('AUTH_BOOTSTRAP_EMAIL, AUTH_BOOTSTRAP_PASSWORD, and AUTH_BOOTSTRAP_CLINIC_ID or DEFAULT_CLINIC_ID are required');
  }

  if (password.length < 12) {
    throw new Error('AUTH_BOOTSTRAP_PASSWORD must be at least 12 characters');
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) throw new Error(`Clinic not found: ${clinicId}`);

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      name,
      passwordHash,
      emailVerifiedAt: new Date(),
      status: 'active',
    },
    create: {
      email,
      name,
      passwordHash,
      emailVerifiedAt: new Date(),
      status: 'active',
    },
  });

  await prisma.clinicMembership.upsert({
    where: { userId_clinicId: { userId: user.id, clinicId } },
    update: { role: 'owner' },
    create: { userId: user.id, clinicId, role: 'owner' },
  });

  console.log(`Owner ready: ${email} for clinic ${clinic.name}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
