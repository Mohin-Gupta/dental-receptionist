import { google } from 'googleapis';
import { prisma } from '../lib/prisma';

// Build the OAuth client
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Step 1: Generate URL the clinic admin visits to authorize
export function getAuthUrl(clinicId: string): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: clinicId,
  });
}

// Step 2: Exchange the code Google returns for tokens, save to DB
export async function handleOAuthCallback(code: string, clinicId: string) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  await prisma.clinic.update({
    where: { id: clinicId },
    data: {
      googleTokens: JSON.stringify(tokens),
    },
  });

  console.log('Google Calendar connected for clinic:', clinicId);
  return tokens;
}

// Helper: build an authenticated client for a clinic
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

  // Auto-refresh token if expired
  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await prisma.clinic.update({
      where: { id: clinicId },
      data: { googleTokens: JSON.stringify(merged) },
    });
  });

  return { oauth2Client, clinic };
}

// Step 3: Get available slots for a given date
export async function getAvailableSlots(
  clinicId: string,
  dateStr: string // YYYY-MM-DD
): Promise<{ start: string; end: string }[]> {
  const { oauth2Client, clinic } = await getAuthenticatedClient(clinicId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const businessHours = clinic.businessHours as Record<string, { open: string; close: string } | null>;
  const date = new Date(dateStr);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase(); // mon, tue...

  const hours = businessHours[dayName];
  if (!hours) {
    return []; // clinic closed that day
  }

  // Build day boundaries in clinic timezone
  const [openHour, openMin] = hours.open.split(':').map(Number);
  const [closeHour, closeMin] = hours.close.split(':').map(Number);

  const dayStart = new Date(dateStr);
  dayStart.setHours(openHour, openMin, 0, 0);

  const dayEnd = new Date(dateStr);
  dayEnd.setHours(closeHour, closeMin, 0, 0);

  // Check Google Calendar for busy times
  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: [{ id: clinic.googleCalendarId ?? 'primary' }],
    },
  });

  const busySlots =
    freeBusy.data.calendars?.[clinic.googleCalendarId ?? 'primary']?.busy ?? [];

  // Generate 30-minute slots and filter out busy ones
  const slots: { start: string; end: string }[] = [];
  const slotDuration = 30 * 60 * 1000; // 30 minutes in ms
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
      slots.push({
        start: slotStart.toTimeString().slice(0, 5), // HH:MM
        end: slotEnd.toTimeString().slice(0, 5),
      });
    }

    current += slotDuration;
  }

  return slots;
}

// Step 4: Create a calendar event when appointment is booked
export async function createCalendarEvent(
  clinicId: string,
  appointment: {
    patientName: string;
    patientPhone: string;
    reason: string;
    startAt: string; // ISO string
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

  return event.data.id!; // return googleEventId
}

// Step 5: Delete event when appointment is cancelled
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