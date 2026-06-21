import { ClinicSettings } from '@/lib/api';

export function getTimezone(
  form: ClinicSettings
): string {
  return (
    form.timezone ??
    'Asia/Kolkata'
  );
}

export function parseYearsOfExperience(
  value: string
): number | null {
  const parsed = parseInt(value, 10);

  return Number.isNaN(parsed)
    ? null
    : parsed;
}

export function createDefaultBusinessHours() {
  return {
    open: '09:00',
    close: '17:00',
  };
}