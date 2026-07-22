import { google } from 'googleapis';
import { prisma } from '../lib/prisma';
import {
  toClinicTimeString,
  addMinutesToClinicString,
  parseInTimezone,
  isTodayInTimezone,
} from '../lib/timezone';
import { decryptSecret, encryptSecret } from '../auth/secretBox';
import crypto from 'crypto';

function calendarSecretPurpose(organizationId: string, ownerId: string): string {
  return `calendar:${organizationId}:${ownerId}`;
}

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

export function getAuthUrl(state: string): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state,
  });
}

export async function handleOAuthCallback(code: string, clinicId: string, doctorId?: string) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  if (doctorId) {
    const doctor = await prisma.doctor.findFirst({
      where: {
        id: doctorId,
        organizationId: clinic.organizationId,
        clinics: { some: { clinicId } },
      },
      select: { id: true },
    });
    if (!doctor) throw new Error('Doctor does not belong to this clinic');
  }
  const ownerId = doctorId ?? clinicId;
  await prisma.$transaction(async tx => {
    await tx.calendarConnection.deleteMany({
      where: {
        organizationId: clinic.organizationId,
        scope: doctorId ? 'doctor' : 'clinic',
        ...(doctorId ? { doctorId } : { clinicId }),
      },
    });
    await tx.calendarConnection.create({
      data: {
      organizationId: clinic.organizationId,
      clinicId: doctorId ? null : clinicId,
      doctorId,
      scope: doctorId ? 'doctor' : 'clinic',
      googleCalendarId: clinic.googleCalendarId,
      googleTokens: encryptSecret(
        JSON.stringify(tokens),
        calendarSecretPurpose(clinic.organizationId, ownerId)
      ),
      },
    });
  });
  return tokens;
}

async function getAuthenticatedClient(clinicId: string, doctorId?: string) {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const connection =
    (doctorId
      ? await prisma.calendarConnection.findFirst({
          where: { doctorId, organizationId: clinic.organizationId, scope: 'doctor' },
          orderBy: { createdAt: 'desc' },
        })
      : null) ??
    (await prisma.calendarConnection.findFirst({
      where: { clinicId, organizationId: clinic.organizationId, scope: 'clinic' },
      orderBy: { createdAt: 'desc' },
    }));

  const rawTokens = connection?.googleTokens ?? clinic.googleTokens;
  if (!rawTokens) throw new Error('Google Calendar not connected');

  const oauth2Client = getOAuthClient();
  const ownerId = connection?.doctorId ?? connection?.clinicId ?? clinicId;
  const tokens = JSON.parse(
    decryptSecret(rawTokens, calendarSecretPurpose(clinic.organizationId, ownerId))
  );
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    if (connection) {
      await prisma.calendarConnection.update({
        where: { id: connection.id },
        data: {
          googleTokens: encryptSecret(
            JSON.stringify(merged),
            calendarSecretPurpose(clinic.organizationId, ownerId)
          ),
        },
      });
    } else {
      await prisma.clinic.update({
        where: { id: clinicId },
        data: {
          googleTokens: encryptSecret(
            JSON.stringify(merged),
            calendarSecretPurpose(clinic.organizationId, clinicId)
          ),
        },
      });
    }
  });

  return {
    oauth2Client,
    clinic,
    calendarId: connection?.googleCalendarId ?? clinic.googleCalendarId ?? 'primary',
  };
}

// ── Availability ──────────────────────────────────────────────────────────────

export async function getAvailableSlots(
  clinicId: string,
  dateStr: string,
  doctorId?: string
): Promise<{ start: string; end: string; label: string }[]> {
  const { oauth2Client, clinic, calendarId } = await getAuthenticatedClient(clinicId, doctorId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const timezone = clinic.timezone ?? 'Asia/Kolkata';

  const businessHours = clinic.businessHours as Record<string, { open: string; close: string } | null>;

  const [year, month, day] = dateStr.split('-').map(Number);
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayName = dayNames[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];

  const doctorAvailability = doctorId
    ? await prisma.doctorAvailability.findFirst({
        where: {
          doctorId,
          organizationId: clinic.organizationId,
          dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
          OR: [{ clinicId }, { clinicId: null }],
        },
        orderBy: { clinicId: 'desc' },
      })
    : null;

  const hours = doctorAvailability
    ? { open: doctorAvailability.open, close: doctorAvailability.close }
    : businessHours[dayName];
  if (!hours) {
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
      return [];
    }
  }

  let dayStartStr: string;
  let dayEndStr: string;
  try {
    dayStartStr = toClinicTimeString(year, month, day, startHour, startMin, timezone);
    dayEndStr = toClinicTimeString(year, month, day, closeHour, closeMin, timezone);
  } catch {
    return [];
  }

  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStartStr,
      timeMax: dayEndStr,
      timeZone: timezone,
      items: [{ id: calendarId }],
    },
  });

  const busySlots =
    freeBusy.data.calendars?.[calendarId]?.busy ?? [];

  const slots: { start: string; end: string; label: string }[] = [];
  const SLOT_MINUTES = 30;

  let curHour = startHour;
  let curMin = startMin;

  while (curHour * 60 + curMin + SLOT_MINUTES <= closeHour * 60 + closeMin) {
    let slotStartStr: string;
    try {
      slotStartStr = toClinicTimeString(year, month, day, curHour, curMin, timezone);
    } catch {
      const totalMin = curHour * 60 + curMin + SLOT_MINUTES;
      curHour = Math.floor(totalMin / 60);
      curMin = totalMin % 60;
      continue;
    }
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

  return slots;
}

// ── Calendar event CRUD ───────────────────────────────────────────────────────

export async function createCalendarEvent(
  clinicId: string,
  appointment: {
    doctorId?: string;
    patientName: string;
    patientPhone: string;
    reason: string;
    startAt: string;
    endAt: string;
    /** Stable operation key used to derive a Google event ID. */
    idempotencyKey?: string;
    /** Non-PHI internal reference displayed when calendar PHI is disabled. */
    appointmentReference?: string;
  }
): Promise<string> {
  const { oauth2Client, clinic, calendarId } = await getAuthenticatedClient(clinicId, appointment.doctorId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const timezone = clinic.timezone ?? 'Asia/Kolkata';

  const allowPhi =
    process.env.GOOGLE_CALENDAR_STORE_PHI === 'true' &&
    process.env.GOOGLE_WORKSPACE_BAA_CONFIRMED === 'true';
  const eventId = appointment.idempotencyKey
    ? `a${crypto.createHash('sha256').update(appointment.idempotencyKey).digest('hex').slice(0, 40)}`
    : undefined;
  try {
    const event = await calendar.events.insert({
      calendarId,
      requestBody: {
        ...(eventId ? { id: eventId } : {}),
        summary: allowPhi
          ? `${appointment.patientName} — ${appointment.reason}`
          : 'Dental appointment',
        description: allowPhi
          ? `Patient phone: ${appointment.patientPhone}`
          : `Managed by the receptionist platform${
              appointment.appointmentReference
                ? `\nInternal reference: ${appointment.appointmentReference}`
                : ''
            }`,
        start: { dateTime: appointment.startAt, timeZone: timezone },
        end: { dateTime: appointment.endAt, timeZone: timezone },
      },
    });
    if (!event.data.id) throw new Error('Google Calendar did not return an event ID');
    return event.data.id;
  } catch (error) {
    const status = (error as { code?: number | string; response?: { status?: number } })?.response?.status ??
      (error as { code?: number | string })?.code;
    if (eventId && (status === 409 || status === '409')) return eventId;
    throw error;
  }
}

export async function deleteCalendarEvent(
  clinicId: string,
  googleEventId: string,
  doctorId?: string
): Promise<void> {
  const { oauth2Client, calendarId } = await getAuthenticatedClient(clinicId, doctorId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  await calendar.events.delete({
    calendarId,
    eventId: googleEventId,
  });

}

export async function updateCalendarEvent(
  clinicId: string,
  googleEventId: string,
  update: {
    doctorId?: string;
    patientName?: string;
    reason?: string;
    startAt?: string;
    endAt?: string;
  }
): Promise<void> {
  const { oauth2Client, clinic, calendarId } = await getAuthenticatedClient(clinicId, update.doctorId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const timezone = clinic.timezone ?? 'Asia/Kolkata';
  const allowPhi =
    process.env.GOOGLE_CALENDAR_STORE_PHI === 'true' &&
    process.env.GOOGLE_WORKSPACE_BAA_CONFIRMED === 'true';

  const patch: Record<string, unknown> = {};
  if (update.patientName || update.reason) {
    patch.summary = allowPhi
      ? `${update.patientName ?? ''} — ${update.reason ?? ''}`.trim()
      : 'Dental appointment';
  }
  if (update.startAt) patch.start = { dateTime: update.startAt, timeZone: timezone };
  if (update.endAt)   patch.end   = { dateTime: update.endAt,   timeZone: timezone };

  await calendar.events.patch({
    calendarId,
    eventId: googleEventId,
    requestBody: patch,
  });

}
