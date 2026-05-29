import { google } from 'googleapis';
import { prisma } from '../lib/prisma';

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
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
  });

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

export async function getAvailableSlots(
  clinicId: string,
  dateStr: string
): Promise<{ start: string; end: string; label: string }[]> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const businessHours = clinic.businessHours as Record<string, { open: string; close: string } | null>;

  // Get day name from date string directly to avoid timezone issues
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayName = dayNames[date.getDay()];

  console.log(`Day for ${dateStr}: ${dayName}`);

  const hours = businessHours[dayName];
  if (!hours) {
    console.log(`Clinic closed on ${dayName}`);
    return [];
  }

  const [openHour, openMin] = hours.open.split(':').map(Number);
  const [closeHour, closeMin] = hours.close.split(':').map(Number);

  const dayStart = new Date(year, month - 1, day, openHour, openMin, 0, 0);
  const dayEnd = new Date(year, month - 1, day, closeHour, closeMin, 0, 0);

  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: [{ id: clinic.googleCalendarId ?? 'primary' }],
    },
  });

  const busySlots =
    freeBusy.data.calendars?.[clinic.googleCalendarId ?? 'primary']?.busy ?? [];

  console.log('Busy slots:', JSON.stringify(busySlots));

  const slots: { start: string; end: string; label: string }[] = [];
  const slotDuration = 30 * 60 * 1000;
  let current = dayStart.getTime();

  while (current + slotDuration <= dayEnd.getTime()) {
    const slotStart = new Date(current);
    const slotEnd = new Date(current + slotDuration);

    const isBusy = busySlots.some((busy) => {
      const busyStart = new Date(busy.start!).getTime();
      const busyEnd = new Date(busy.end!).getTime();
      return current < busyEnd && current + slotDuration > busyStart;
    });

    if (!isBusy) {
      const h = slotStart.getHours();
      const m = slotStart.getMinutes();
      const time24 = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      const period = h >= 12 ? 'PM' : 'AM';
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      const minuteStr = m === 0 ? '00' : m.toString().padStart(2, '0');
      const label = `${hour12}:${minuteStr} ${period}`;

      slots.push({ start: time24, end: slotEnd.toTimeString().slice(0, 5), label });
    }

    current += slotDuration;
  }

  console.log('Available slots:', slots);
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
      start: {
        dateTime: appointment.startAt,
        timeZone: clinic.timezone,
      },
      end: {
        dateTime: appointment.endAt,
        timeZone: clinic.timezone,
      },
    },
  });

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
}