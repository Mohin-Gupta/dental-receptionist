import { prisma } from '../lib/prisma';

export async function buildClinicContext(clinicId: string): Promise<string> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
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

  return `
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
- Name: ${clinic.doctorName ?? 'Our dentist'}
- Qualification: ${clinic.doctorQualification ?? 'Qualified dentist'}
- Specialty: ${clinic.doctorSpecialty ?? 'General dentistry'}
- Years of experience: ${clinic.doctorYOE ?? 'Several'} years
`.trim();
}