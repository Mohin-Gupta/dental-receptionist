import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const clinic = await prisma.clinic.create({
    data: {
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

  console.log('✓ Clinic created');
  console.log('Copy this into your .env → DEFAULT_CLINIC_ID=' + clinic.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
