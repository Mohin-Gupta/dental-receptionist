import { format } from 'date-fns';

export function toIST(
  utcStr: string
): string {
  const d = new Date(
    new Date(utcStr).getTime() +
      5.5 * 60 * 60 * 1000
  );

  return format(
    d,
    'MMM d, yyyy'
  );
}

export function getLastVisit(
  startAt?: string
): string {
  if (!startAt) return '—';

  return toIST(startAt);
}

export function getInitial(
  name: string
): string {
  return name
    .charAt(0)
    .toUpperCase();
}