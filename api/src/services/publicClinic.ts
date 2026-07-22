import { Prisma } from '@prisma/client';

/**
 * Safe dashboard projection for Clinic. In particular, never add googleTokens
 * here: legacy rows may still contain usable OAuth credentials.
 */
export const publicClinicSelect = {
  id: true,
  organizationId: true,
  name: true,
  phone: true,
  timezone: true,
  countryCode: true,
  defaultCallingCode: true,
  locale: true,
  googleCalendarId: true,
  businessHours: true,
  lastAgendaSentDate: true,
  clinicAddress: true,
  clinicEmail: true,
  clinicWebsite: true,
  clinicServices: true,
  clinicAbout: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClinicSelect;
