import { google } from 'googleapis';
import { prisma } from '../lib/prisma';

// ─── IST helpers ────────────────────────────────────────────────────────────
// Railway runs in UTC. We NEVER use new Date() for wall-clock arithmetic.
// Instead we build ISO-8601 strings with the +05:30 offset directly so that
// Google Calendar (and the DB) always receive the correct IST moment.

const IST_OFFSET = '+05:30';

/**
 * Build an IST ISO-8601 string like "2025-06-01T10:00:00+05:30"
 * from plain parts. No timezone conversion involved.
 */
function toISTString(year: number, month: number, day: number, hour: number, minute: number): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${IST_OFFSET}`;
}

/**
 * Parse an IST ISO-8601 string back to parts WITHOUT shifting timezone.
 * We just chop the string — no Date math.
 */
function parseISTString(isoStr: string): { year: number; month: number; day: number; hour: number; minute: number } {
  // Handles "2025-06-01T10:00:00+05:30" or "2025-06-01T10:00:00.000Z" (UTC from DB)
  // For DB-stored UTC values we convert: subtract nothing, just read the IST-offset string we stored.
  const dt = new Date(isoStr);
  // shift to IST manually
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istMs = dt.getTime() + IST_OFFSET_MS;
  const ist = new Date(istMs);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
  };
}

/**
 * Add minutes to an IST ISO-8601 string, returning a new IST ISO-8601 string.
 */
function addMinutesToISTString(isoStr: string, minutes: number): string {
  const { year, month, day, hour, minute } = parseISTString(isoStr);
  const totalMinutes = hour * 60 + minute + minutes;
  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMinute = totalMinutes % 60;
  const extraDays = Math.floor(totalMinutes / (60 * 24));
  // Handle day overflow (simple: add extraDays to a Date just for the date part)
  const baseDate = new Date(Date.UTC(year, month - 1, day + extraDays));
  return toISTString(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth() + 1,
    baseDate.getUTCDate(),
    newHour,
    newMinute
  );
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(clinicId: string): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: clinicId,
  });
}

export async function handleOAuthCallback(code: string, clinicId: string) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  await prisma.clinic.update({
    where: { id: clinicId },
    data: { googleTokens: JSON.stringify(tokens) },
  });
  console.log('Google Calendar connected for clinic:', clinicId);
  return tokens;
}

async function getAuthenticatedClient(clinicId: string) {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });

  if (!clinic.googleTokens) {
    throw new Error('Google Calendar not connected for this clinic');
  }

  const oauth2Client = getOAuthClient();
  const tokens = JSON.parse(clinic.googleTokens as string);
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await prisma.clinic.update({
      where: { id: clinicId },
      data: { googleTokens: JSON.stringify(merged) },
    });
  });

  return { oauth2Client, clinic };
}

// ─── Availability ────────────────────────────────────────────────────────────

export async function getAvailableSlots(
  clinicId: string,
  dateStr: string // "YYYY-MM-DD"
): Promise<{ start: string; end: string; label: string }[]> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const businessHours = clinic.businessHours as Record<
    string,
    { open: string; close: string } | null
  >;

  // Parse date parts directly — no timezone shift
  const [year, month, day] = dateStr.split('-').map(Number);
  // Use UTC date constructor so the server's local TZ doesn't affect getDay()
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayName = dayNames[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];

  console.log(`Day for ${dateStr}: ${dayName}`);

  const hours = businessHours[dayName];
  if (!hours) {
    console.log(`Clinic closed on ${dayName}`);
    return [];
  }

  const [openHour, openMin] = hours.open.split(':').map(Number);
  const [closeHour, closeMin] = hours.close.split(':').map(Number);

  // Build IST boundary strings — these carry +05:30 so Google interprets them correctly
  const dayStartIST = toISTString(year, month, day, openHour, openMin);
  const dayEndIST = toISTString(year, month, day, closeHour, closeMin);

  console.log('Querying freebusy:', dayStartIST, '→', dayEndIST);

  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStartIST,
      timeMax: dayEndIST,
      timeZone: 'Asia/Kolkata',
      items: [{ id: clinic.googleCalendarId ?? 'primary' }],
    },
  });

  const busySlots =
    freeBusy.data.calendars?.[clinic.googleCalendarId ?? 'primary']?.busy ?? [];

  console.log('Busy slots from Google:', JSON.stringify(busySlots));

  const slots: { start: string; end: string; label: string }[] = [];
  const SLOT_MINUTES = 30;

  let curHour = openHour;
  let curMin = openMin;

  while (curHour * 60 + curMin + SLOT_MINUTES <= closeHour * 60 + closeMin) {
    const slotStartIST = toISTString(year, month, day, curHour, curMin);
    const slotEndIST = addMinutesToISTString(slotStartIST, SLOT_MINUTES);

    const slotStartMs = new Date(slotStartIST).getTime();
    const slotEndMs = new Date(slotEndIST).getTime();

    const isBusy = busySlots.some((busy) => {
      const busyStart = new Date(busy.start!).getTime();
      const busyEnd = new Date(busy.end!).getTime();
      return slotStartMs < busyEnd && slotEndMs > busyStart;
    });

    if (!isBusy) {
      const period = curHour >= 12 ? 'PM' : 'AM';
      const hour12 = curHour % 12 === 0 ? 12 : curHour % 12;
      const minuteStr = curMin === 0 ? '00' : curMin.toString().padStart(2, '0');
      const label = `${hour12}:${minuteStr} ${period}`;
      const endHour = Math.floor((curHour * 60 + curMin + SLOT_MINUTES) / 60);
      const endMin = (curMin + SLOT_MINUTES) % 60;

      slots.push({
        start: `${curHour.toString().padStart(2, '0')}:${curMin.toString().padStart(2, '0')}`,
        end: `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`,
        label,
      });
    }

    // Advance by slot duration
    const totalMin = curHour * 60 + curMin + SLOT_MINUTES;
    curHour = Math.floor(totalMin / 60);
    curMin = totalMin % 60;
  }

  console.log('Available slots (IST):', slots);
  return slots;
}

// ─── Create event ─────────────────────────────────────────────────────────────

/**
 * startAt / endAt must be IST ISO-8601 strings ("YYYY-MM-DDTHH:mm:ss+05:30")
 * as produced by toISTString() in the webhook.
 */
export async function createCalendarEvent(
  clinicId: string,
  appointment: {
    patientName: string;
    patientPhone: string;
    reason: string;
    startAt: string; // IST ISO string e.g. "2025-06-01T10:00:00+05:30"
    endAt: string;
  }
): Promise<string> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  console.log('Creating calendar event:', appointment.startAt, '→', appointment.endAt);

  const event = await calendar.events.insert({
    calendarId: clinic.googleCalendarId ?? 'primary',
    requestBody: {
      summary: `${appointment.patientName} — ${appointment.reason}`,
      description: `Patient phone: ${appointment.patientPhone}\nBooked by Maya (AI Receptionist)`,
      start: {
        dateTime: appointment.startAt,
        timeZone: 'Asia/Kolkata',
      },
      end: {
        dateTime: appointment.endAt,
        timeZone: 'Asia/Kolkata',
      },
    },
  });

  console.log('Event created:', event.data.id, 'at', event.data.start?.dateTime);
  return event.data.id!;
}

// ─── Delete event ─────────────────────────────────────────────────────────────

export async function deleteCalendarEvent(
  clinicId: string,
  googleEventId: string
): Promise<void> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  await calendar.events.delete({
    calendarId: clinic.googleCalendarId ?? 'primary',
    eventId: googleEventId,
  });

  console.log('Calendar event deleted:', googleEventId);
}

// ─── Update event ─────────────────────────────────────────────────────────────

/**
 * startAt / endAt must be IST ISO-8601 strings.
 */
export async function updateCalendarEvent(
  clinicId: string,
  googleEventId: string,
  update: {
    patientName?: string;
    reason?: string;
    startAt?: string;
    endAt?: string;
  }
): Promise<void> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const patch: Record<string, unknown> = {};

  if (update.patientName || update.reason) {
    patch.summary = `${update.patientName ?? ''} — ${update.reason ?? ''}`.trim();
  }
  if (update.startAt) {
    patch.start = { dateTime: update.startAt, timeZone: 'Asia/Kolkata' };
  }
  if (update.endAt) {
    patch.end = { dateTime: update.endAt, timeZone: 'Asia/Kolkata' };
  }

  await calendar.events.patch({
    calendarId: clinic.googleCalendarId ?? 'primary',
    eventId: googleEventId,
    requestBody: patch,
  });

  console.log('Calendar event updated:', googleEventId);
}

// Re-export helpers so the webhook can use them
export { toISTString, addMinutesToISTString };