import { prisma } from '../lib/prisma';

export async function buildClinicContext(clinicId: string): Promise<string> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      organization: true,
      doctors: { include: { doctor: true } },
    },
  });

  if (!clinic) return '';

  const services = Array.isArray(clinic.clinicServices)
    ? (clinic.clinicServices as string[]).join(', ')
    : 'General dentistry services';

  const businessHours = clinic.businessHours as Record<string, { open: string; close: string } | null>;
  const hoursText = Object.entries(businessHours)
    .map(([day, hrs]) => {
      if (!hrs) return `${day}: Closed`;
      return `${day}: ${hrs.open} – ${hrs.close}`;
    })
    .join(', ');
  const doctorsText = clinic.doctors.length
    ? clinic.doctors
        .map(({ doctor }) => {
          const details = [
            doctor.qualification,
            doctor.specialty,
            doctor.yearsExperience ? `${doctor.yearsExperience} years experience` : null,
          ].filter(Boolean).join(', ');
          return `${doctor.name}${details ? ` (${details})` : ''}`;
        })
        .join('; ')
    : 'Our dental team';

  return `
ORGANIZATION:
- Name: ${clinic.organization.name}
- Phone: ${clinic.organization.phone ?? clinic.phone}
- Website: ${clinic.organization.website ?? clinic.clinicWebsite ?? 'Not available'}

CLINIC INFORMATION:
- Name: ${clinic.name}
- Address: ${clinic.clinicAddress ?? 'Contact clinic for address'}
- Phone: ${clinic.phone}
- Email: ${clinic.clinicEmail ?? 'Contact clinic for email'}
- Website: ${clinic.clinicWebsite ?? 'Not available'}
- About: ${clinic.clinicAbout ?? ''}
- Services offered: ${services}
- Hours: ${hoursText}

DOCTOR INFORMATION:
- Doctors: ${doctorsText}
`.trim();
}
