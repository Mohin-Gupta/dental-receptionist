import { prisma } from '../lib/prisma';

export async function listDoctorsForClinic(organizationId: string, clinicId: string) {
  return prisma.doctor.findMany({
    where: {
      organizationId,
      status: 'active',
      clinics: { some: { clinicId } },
    },
    orderBy: { name: 'asc' },
  });
}

export async function resolveDoctorForClinic(
  organizationId: string,
  clinicId: string,
  doctorId?: string | null
) {
  if (doctorId) {
    const doctor = await prisma.doctor.findFirst({
      where: {
        id: doctorId,
        organizationId,
        status: 'active',
        clinics: { some: { clinicId } },
      },
    });

    if (!doctor) {
      throw new Error('Doctor is not available for this clinic');
    }

    return doctor;
  }

  const [doctor] = await listDoctorsForClinic(organizationId, clinicId);
  if (!doctor) {
    throw new Error('No active doctor is assigned to this clinic');
  }

  return doctor;
}
