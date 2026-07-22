import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const organization = await prisma.organization.create({
    data: {
      name: 'Smile Dental Group',
      phone: '+1xxxxxxxxxx',
      planTier: 'starter',
      status: 'active',
    },
  });

  const clinic = await prisma.clinic.create({
    data: {
      organizationId: organization.id,
      name: 'Smile Dental Clinic',
      phone: '+1xxxxxxxxxx',
      timezone: 'Asia/Kolkata',
      businessHours: {
        mon: { open: '09:00', close: '18:00' },
        tue: { open: '09:00', close: '18:00' },
        wed: { open: '09:00', close: '18:00' },
        thu: { open: '09:00', close: '18:00' },
        fri: { open: '09:00', close: '18:00' },
        sat: { open: '10:00', close: '14:00' },
        sun: null,
      },
    },
  });

  await prisma.doctor.create({
    data: {
      organizationId: organization.id,
      name: 'Smile Dental Doctor',
      clinics: {
        create: { organizationId: organization.id, clinicId: clinic.id },
      },
    },
  });

  await prisma.entitlement.createMany({
    data: [
      'appointments.write',
      'communications.voice',
      'communications.sms',
    ].map((key) => ({
      organizationId: organization.id,
      key,
      enabled: true,
      source: 'development-seed',
    })),
  });
  await prisma.entitlement.create({
    data: {
      organizationId: organization.id,
      key: 'clinics.max',
      enabled: true,
      limit: 1,
      value: 1,
      source: 'development-seed',
    },
  });

  console.log('✓ Organization, clinic, and doctor created');
  console.log('Seeded development organization:', organization.id);
  console.log('Seeded development clinic:', clinic.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
