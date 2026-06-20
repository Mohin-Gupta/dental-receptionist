import { google } from 'googleapis';
import { prisma } from '../lib/prisma';
import {
  toClinicTimeString,
  addMinutesToClinicString,
  parseInTimezone,
  isTodayInTimezone,
} from '../lib/timezone';

// ── Legacy export aliases (kept for any remaining call sites) ────────────────
export function toISTString(year: number, month: number, day: number, hour: number, minute: number): string {
  return toClinicTimeString(year, month, day, hour, minute, 'Asia/Kolkata');
}

export function addMinutesToISTString(isoStr: string, minutes: number): string {
  return addMinutesToClinicString(isoStr, minutes, 'Asia/Kolkata');
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

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
  if (!clinic.googleTokens) throw new Error('Google Calendar not connected');

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

// ── Availability ──────────────────────────────────────────────────────────────

export async function getAvailableSlots(
  clinicId: string,
  dateStr: string
): Promise<{ start: string; end: string; label: string }[]> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const timezone = clinic.timezone ?? 'Asia/Kolkata';

  const businessHours = clinic.businessHours as Record<string, { open: string; close: string } | null>;

  const [year, month, day] = dateStr.split('-').map(Number);
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

  const isToday = isTodayInTimezone(dateStr, timezone);
  const nowInTz = parseInTimezone(new Date().toISOString(), timezone);

  // Default: clinic opening time
  let startHour = openHour;
  let startMin = openMin;

  if (isToday) {
    // "Now + 30min buffer" — but this must never be EARLIER than the clinic's
    // actual opening time. Without clamping, a call at 1 AM asking for "today"
    // would compute a start time of 1:30 AM and show slots hours before the
    // clinic even opens. We take whichever is LATER: now+30min, or opening time.
    const nowPlusBufferMins = nowInTz.hour * 60 + nowInTz.minute + 30;
    const openingMins = openHour * 60 + openMin;
    const effectiveStartMins = Math.max(nowPlusBufferMins, openingMins);

    // Round up to the nearest 30-min slot boundary
    const roundedMins = effectiveStartMins % 30 === 0
      ? effectiveStartMins
      : effectiveStartMins + (30 - (effectiveStartMins % 30));

    startHour = Math.floor(roundedMins / 60);
    startMin = roundedMins % 60;

    // If the (clamped, rounded) start time is already past closing, no slots today
    if (startHour * 60 + startMin >= closeHour * 60 + closeMin) {
      console.log('No more slots today — all slots have passed or clinic is closed');
      return [];
    }
  }

  const dayStartStr = toClinicTimeString(year, month, day, startHour, startMin, timezone);
  const dayEndStr   = toClinicTimeString(year, month, day, closeHour, closeMin, timezone);

  console.log(`Querying freebusy: ${dayStartStr} → ${dayEndStr}`);

  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStartStr,
      timeMax: dayEndStr,
      timeZone: timezone,
      items: [{ id: clinic.googleCalendarId ?? 'primary' }],
    },
  });

  const busySlots =
    freeBusy.data.calendars?.[clinic.googleCalendarId ?? 'primary']?.busy ?? [];

  console.log('Busy slots:', JSON.stringify(busySlots));

  const slots: { start: string; end: string; label: string }[] = [];
  const SLOT_MINUTES = 30;

  let curHour = startHour;
  let curMin = startMin;

  while (curHour * 60 + curMin + SLOT_MINUTES <= closeHour * 60 + closeMin) {
    const slotStartStr = toClinicTimeString(year, month, day, curHour, curMin, timezone);
    const slotEndStr   = addMinutesToClinicString(slotStartStr, SLOT_MINUTES, timezone);

    const slotStartMs = new Date(slotStartStr).getTime();
    const slotEndMs   = new Date(slotEndStr).getTime();

    if (slotStartMs <= Date.now()) {
      const totalMin = curHour * 60 + curMin + SLOT_MINUTES;
      curHour = Math.floor(totalMin / 60);
      curMin = totalMin % 60;
      continue;
    }

    const isBusy = busySlots.some((busy) => {
      const busyStart = new Date(busy.start!).getTime();
      const busyEnd   = new Date(busy.end!).getTime();
      return slotStartMs < busyEnd && slotEndMs > busyStart;
    });

    if (!isBusy) {
      const period  = curHour >= 12 ? 'PM' : 'AM';
      const hour12  = curHour % 12 === 0 ? 12 : curHour % 12;
      const minuteStr = curMin === 0 ? '00' : curMin.toString().padStart(2, '0');
      const label   = `${hour12}:${minuteStr} ${period}`;

      slots.push({
        start: `${curHour.toString().padStart(2, '0')}:${curMin.toString().padStart(2, '0')}`,
        end:   addMinutesToClinicString(slotStartStr, SLOT_MINUTES, timezone).slice(11, 16),
        label,
      });
    }

    const totalMin = curHour * 60 + curMin + SLOT_MINUTES;
    curHour = Math.floor(totalMin / 60);
    curMin  = totalMin % 60;
  }

  console.log(`Available slots (${timezone}):`, slots);
  return slots;
}

// ── Calendar event CRUD ───────────────────────────────────────────────────────

export async function createCalendarEvent(
  clinicId: string,
  appointment: {
    patientName: string;
    patientPhone: string;
    reason: string;
    startAt: string;
    endAt: string;
  }
): Promise<string> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const timezone = clinic.timezone ?? 'Asia/Kolkata';

  const event = await calendar.events.insert({
    calendarId: clinic.googleCalendarId ?? 'primary',
    requestBody: {
      summary: `${appointment.patientName} — ${appointment.reason}`,
      description: `Patient phone: ${appointment.patientPhone}\nBooked by Maya (AI Receptionist)`,
      start: { dateTime: appointment.startAt, timeZone: timezone },
      end:   { dateTime: appointment.endAt,   timeZone: timezone },
    },
  });

  console.log('Event created:', event.data.id, 'at', event.data.start?.dateTime);
  return event.data.id!;
}

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

  console.log('Event deleted:', googleEventId);
}

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
  const timezone = clinic.timezone ?? 'Asia/Kolkata';

  const patch: Record<string, unknown> = {};
  if (update.patientName || update.reason) {
    patch.summary = `${update.patientName ?? ''} — ${update.reason ?? ''}`.trim();
  }
  if (update.startAt) patch.start = { dateTime: update.startAt, timeZone: timezone };
  if (update.endAt)   patch.end   = { dateTime: update.endAt,   timeZone: timezone };

  await calendar.events.patch({
    calendarId: clinic.googleCalendarId ?? 'primary',
    eventId: googleEventId,
    requestBody: patch,
  });

  console.log('Event updated:', googleEventId);
}