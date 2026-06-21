import type { CallsResponse } from '@/lib/api';

export function formatDuration(
  secs: number | null
): string {
  if (!secs) return '—';

  const m = Math.floor(secs / 60);
  const s = secs % 60;

  return m > 0
    ? `${m}m ${s}s`
    : `${s}s`;
}

export function getDisplayPhone(
  call: CallsResponse['calls'][number]
): string {
  return (
    call.phoneNumber ??
    call.patient?.phone ??
    'No number recorded'
  );
}

export type DirectionTab =
  | 'inbound'
  | 'outbound';