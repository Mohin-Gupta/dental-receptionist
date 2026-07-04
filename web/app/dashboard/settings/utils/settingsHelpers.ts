import { BranchSettings } from '@/lib/api';

export function getTimezone(
  form: BranchSettings
): string {
  return (
    form.timezone ??
    'Asia/Kolkata'
  );
}

export function createDefaultBusinessHours() {
  return {
    open: '09:00',
    close: '17:00',
  };
}
