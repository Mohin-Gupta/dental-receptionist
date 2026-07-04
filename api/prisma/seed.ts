import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const organization = await prisma.organization.create({
    data: {
      name: 'Smile Dental Group',
      phone: '+1xxxxxxxxxx',
      planTier: 'starter',
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
        create: { clinicId: clinic.id },
      },
    },
  });

  console.log('✓ Organization, clinic, and doctor created');
  console.log('Copy this into your .env → DEFAULT_ORGANIZATION_ID=' + organization.id);
  console.log('Copy this into your .env → DEFAULT_CLINIC_ID=' + clinic.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
