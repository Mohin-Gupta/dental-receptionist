import { google } from 'googleapis';
import { prisma } from '../lib/prisma';

const IST_OFFSET = '+05:30';

export function toISTString(year: number, month: number, day: number, hour: number, minute: number): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${IST_OFFSET}`;
}

function parseISTString(isoStr: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const dt = new Date(isoStr);
  const istMs = dt.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
  };
}

export function addMinutesToISTString(isoStr: string, minutes: number): string {
  const { year, month, day, hour, minute } = parseISTString(isoStr);
  const totalMinutes = hour * 60 + minute + minutes;
  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMinute = totalMinutes % 60;
  const extraDays = Math.floor(totalMinutes / (60 * 24));
  const baseDate = new Date(Date.UTC(year, month - 1, day + extraDays));
  return toISTString(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth() + 1,
    baseDate.getUTCDate(),
    newHour,
    newMinute
  );
}

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

export async function getAvailableSlots(
  clinicId: string,
  dateStr: string
): Promise<{ start: string; end: string; label: string }[]> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

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

  // For today, start from next available slot (current time + 30min buffer)
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const isToday =
    nowIST.getUTCFullYear() === year &&
    nowIST.getUTCMonth() + 1 === month &&
    nowIST.getUTCDate() === day;

  let startHour = openHour;
  let startMin = openMin;

  if (isToday) {
    const nowMins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes() + 30;
    const roundedHour = Math.floor(nowMins / 60);
    const roundedMin = nowMins % 60 >= 30 ? 30 : 0;
    startHour = roundedMin === 0 ? roundedHour : roundedHour;
    startMin = roundedMin;

    // If current time already past close, return empty
    if (startHour * 60 + startMin >= closeHour * 60 + closeMin) {
      console.log('No more slots today — all slots have passed');
      return [];
    }
  }

  const dayStartIST = toISTString(year, month, day, startHour, startMin);
  const dayEndIST = toISTString(year, month, day, closeHour, closeMin);

  console.log(`Querying freebusy: ${dayStartIST} → ${dayEndIST}`);

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

  console.log('Busy slots:', JSON.stringify(busySlots));

  const slots: { start: string; end: string; label: string }[] = [];
  const SLOT_MINUTES = 30;

  let curHour = startHour;
  let curMin = startMin;

  while (curHour * 60 + curMin + SLOT_MINUTES <= closeHour * 60 + closeMin) {
    const slotStartIST = toISTString(year, month, day, curHour, curMin);
    const slotEndIST = addMinutesToISTString(slotStartIST, SLOT_MINUTES);

    const slotStartMs = new Date(slotStartIST).getTime();
    const slotEndMs = new Date(slotEndIST).getTime();

    // Skip past slots
    if (slotStartMs <= Date.now()) {
      const totalMin = curHour * 60 + curMin + SLOT_MINUTES;
      curHour = Math.floor(totalMin / 60);
      curMin = totalMin % 60;
      continue;
    }

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

      slots.push({
        start: `${curHour.toString().padStart(2, '0')}:${curMin.toString().padStart(2, '0')}`,
        end: addMinutesToISTString(slotStartIST, SLOT_MINUTES).slice(11, 16),
        label,
      });
    }

    const totalMin = curHour * 60 + curMin + SLOT_MINUTES;
    curHour = Math.floor(totalMin / 60);
    curMin = totalMin % 60;
  }

  console.log(`Available slots (IST):`, slots);
  return slots;
}

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

  const event = await calendar.events.insert({
    calendarId: clinic.googleCalendarId ?? 'primary',
    requestBody: {
      summary: `${appointment.patientName} — ${appointment.reason}`,
      description: `Patient phone: ${appointment.patientPhone}\nBooked by Maya (AI Receptionist)`,
      start: { dateTime: appointment.startAt, timeZone: 'Asia/Kolkata' },
      end: { dateTime: appointment.endAt, timeZone: 'Asia/Kolkata' },
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

  const patch: Record<string, unknown> = {};
  if (update.patientName || update.reason) {
    patch.summary = `${update.patientName ?? ''} — ${update.reason ?? ''}`.trim();
  }
  if (update.startAt) patch.start = { dateTime: update.startAt, timeZone: 'Asia/Kolkata' };
  if (update.endAt) patch.end = { dateTime: update.endAt, timeZone: 'Asia/Kolkata' };

  await calendar.events.patch({
    calendarId: clinic.googleCalendarId ?? 'primary',
    eventId: googleEventId,
    requestBody: patch,
  });

  console.log('Event updated:', googleEventId);
}