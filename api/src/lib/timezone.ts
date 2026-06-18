/**
 * timezone.ts — single source of truth for all clinic date/time operations.
 *
 * All functions accept an IANA timezone string (e.g. "Asia/Kolkata", "America/New_York").
 * Nothing here is hardcoded to IST. The clinic's `timezone` column drives everything.
 *
 * Usage:
 *   import { clinicNow, toClinicTimeString, formatInTimezone } from '../lib/timezone';
 */

// ── Core: current time in a given timezone ────────────────────────────────────

/** Returns the current Date object (UTC). Use with formatInTimezone for display. */
export function now(): Date {
  return new Date();
}

/** Returns the current hour (0–23) in the clinic's timezone. */
export function currentHourInTz(timezone: string): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false })
      .format(new Date()),
    10
  );
}

/** True if current time in the given timezone is between startHour and endHour (exclusive). */
export function isWithinHours(timezone: string, startHour: number, endHour: number): boolean {
  const hour = currentHourInTz(timezone);
  return hour >= startHour && hour < endHour;
}

// ── Building ISO strings with correct offset ──────────────────────────────────

/**
 * Builds an ISO 8601 string for a given local date/time in the clinic's timezone.
 * e.g. toClinicTimeString(2025, 6, 15, 10, 30, "Asia/Kolkata") → "2025-06-15T10:30:00+05:30"
 *
 * Works by constructing a UTC Date that corresponds to the local time, then
 * formatting with the timezone offset. Compatible with Google Calendar API.
 */
export function toClinicTimeString(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): string {
  // Use Intl to get the UTC offset for this timezone at this moment
  const pad = (n: number) => n.toString().padStart(2, '0');

  // Build a date string that we can interpret as local time in the target tz
  // We use the trick of formatting a known UTC time and seeing the offset
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  // Get the offset string for this timezone at this date
  const offsetStr = getOffsetString(probe, timezone);

  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${offsetStr}`;
}

/**
 * Returns the UTC offset string (e.g. "+05:30", "-04:00") for a timezone at a given Date.
 * Handles DST correctly since it uses the actual date.
 */
export function getOffsetString(date: Date, timezone: string): string {
  // Format the date in the target timezone to extract offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });

  const parts = formatter.formatToParts(date);
  const tzPart = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0';

  // tzPart looks like "GMT+5:30" or "GMT-4:00" or "GMT"
  if (tzPart === 'GMT') return '+00:00';

  const match = tzPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!match) return '+00:00';

  const sign = match[1];
  const hours = match[2].padStart(2, '0');
  const minutes = (match[3] ?? '00').padStart(2, '0');

  return `${sign}${hours}:${minutes}`;
}

// ── Parsing: ISO string → local components in clinic timezone ────────────────

/**
 * Parses an ISO string and returns date/time components in the clinic's timezone.
 */
export function parseInTimezone(
  isoStr: string,
  timezone: string
): { year: number; month: number; day: number; hour: number; minute: number } {
  const date = new Date(isoStr);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,   // Intl returns 24 for midnight in some locales
    minute: get('minute'),
  };
}

// ── Adding minutes to a clinic-timezone ISO string ───────────────────────────

/**
 * Adds minutes to an ISO string, returning a new ISO string in the same timezone.
 */
export function addMinutesToClinicString(isoStr: string, minutes: number, timezone: string): string {
  const { year, month, day, hour, minute } = parseInTimezone(isoStr, timezone);
  const totalMinutes = hour * 60 + minute + minutes;
  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMinute = totalMinutes % 60;
  const extraDays = Math.floor(totalMinutes / (60 * 24));
  const baseDate = new Date(Date.UTC(year, month - 1, day + extraDays));
  return toClinicTimeString(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth() + 1,
    baseDate.getUTCDate(),
    newHour,
    newMinute,
    timezone
  );
}

// ── Formatting for display ────────────────────────────────────────────────────

/**
 * Formats a UTC Date for human-readable display in the clinic's timezone.
 * Returns { readableDate, readableTime } e.g. { "Jun 15", "10:30 AM" }
 */
export function formatInTimezone(
  date: Date,
  timezone: string
): { readableDate: string; readableTime: string } {
  const { year, month, day, hour, minute } = parseInTimezone(date.toISOString(), timezone);

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minuteStr = minute === 0 ? '' : `:${minute.toString().padStart(2, '0')}`;

  return {
    readableDate: `${monthNames[month - 1]} ${day}`,
    readableTime: `${hour12}${minuteStr} ${period}`,
  };
}

/**
 * Returns a full readable datetime string for a UTC date in the clinic's timezone.
 * e.g. "Jun 15 at 10:30 AM"
 */
export function formatDateTimeInTimezone(date: Date, timezone: string): string {
  const { readableDate, readableTime } = formatInTimezone(date, timezone);
  return `${readableDate} at ${readableTime}`;
}

// ── "Is today" check in clinic timezone ──────────────────────────────────────

/**
 * Returns true if the given date string (YYYY-MM-DD) is today in the clinic's timezone.
 */
export function isTodayInTimezone(dateStr: string, timezone: string): boolean {
  const todayParts = parseInTimezone(new Date().toISOString(), timezone);
  const [year, month, day] = dateStr.split('-').map(Number);
  return todayParts.year === year && todayParts.month === month && todayParts.day === day;
}

/**
 * Returns today's start and end as UTC Dates for DB range queries,
 * based on the clinic's timezone.
 *
 * e.g. for IST (UTC+5:30), "today" starts at UTC 18:30 the previous day
 * and ends 24h later.
 */
export function getTodayRangeInTimezone(timezone: string): { todayStart: Date; todayEnd: Date } {
  const nowParts = parseInTimezone(new Date().toISOString(), timezone);

  // Midnight in clinic timezone
  const midnightISO = toClinicTimeString(
    nowParts.year, nowParts.month, nowParts.day, 0, 0, timezone
  );

  const todayStart = new Date(midnightISO);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  return { todayStart, todayEnd };
}

// ── Clinic timezone loader ────────────────────────────────────────────────────

/**
 * Fetches the timezone string for a clinic from the DB.
 * Falls back to "Asia/Kolkata" if not set (for backward compat with existing clinics).
 */
export async function getClinicTimezone(clinicId: string): Promise<string> {
  // Import lazily to avoid circular deps
  const { prisma } = await import('./prisma');
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { timezone: true },
  });
  return clinic?.timezone ?? 'Asia/Kolkata';
}