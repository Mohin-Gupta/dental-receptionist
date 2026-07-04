import { prisma } from '../lib/prisma';
import { createCalendarEvent } from '../services/googleCalendar';
import { toClinicTimeString, addMinutesToClinicString, formatInTimezone, getClinicTimezone } from '../lib/timezone';
import { slotCache, confirmedDetails, nameCache, clearCallState } from './state';
import { normalizeTime, toReadableTime } from './helpers';
import { scheduleReminders } from '../queues/reminderQueue';
import { sendSMS } from '../services/twilio';
import { resolveDoctorForClinic } from '../services/doctors';

export async function bookAppointment(
  clinicId: string,
  callId: string,
  parameters: any
): Promise<string> {
  const confirmed    = confirmedDetails[callId];
  const patientName  = nameCache[callId] ?? confirmed?.patientName ?? parameters.patientName;
  const patientPhone = (confirmed?.patientPhone ?? parameters.patientPhone ?? '').replace(/\D/g, '');
  const date         = confirmed?.date ?? parameters.date;
  const time         = confirmed?.time ?? parameters.time;
  const reason       = confirmed?.reason ?? parameters.reason ?? 'General visit';

  console.log('Booking:', { patientName, patientPhone, date, time, reason });

  const finalTime = normalizeTime(time);
  const [year, month, day] = date.split('-').map(Number);
  const [hour, min]        = finalTime.split(':').map(Number);

  // Load clinic timezone — single DB call, used everywhere below
  const timezone = await getClinicTimezone(clinicId);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const organizationId = clinic.organizationId;
  const doctor = await resolveDoctorForClinic(organizationId, clinicId, parameters.doctorId);

  const startAtStr  = toClinicTimeString(year, month, day, hour, min, timezone);
  const endAtStr    = addMinutesToClinicString(startAtStr, 30, timezone);
  const startAtDate = new Date(startAtStr);
  const endAtDate   = new Date(endAtStr);

  if (isNaN(startAtDate.getTime())) throw new Error(`Invalid date: ${date} ${finalTime}`);

  let patient = await prisma.patient.findUnique({
    where: { organizationId_phone: { organizationId, phone: patientPhone } },
  });

  if (!patient) {
    patient = await prisma.patient.create({
      data: { organizationId, clinicId, name: patientName, phone: patientPhone },
    });
  } else {
    await prisma.patient.update({
      where: { id: patient.id },
      data: { name: patientName },
    });
  }

  const googleEventId = await createCalendarEvent(clinicId, {
    doctorId: doctor.id,
    patientName, patientPhone, reason,
    startAt: startAtStr, endAt: endAtStr,
  });

  const appointment = await prisma.appointment.create({
    data: {
      organizationId, clinicId, doctorId: doctor.id, patientId: patient.id, reason,
      startAt: startAtDate, endAt: endAtDate,
      status: 'scheduled', googleEventId,
    },
  });

  clearCallState(callId);
  console.log('Booked ✓', appointment.id);

  // ── Booking confirmation SMS ───────────────────────────────────────────────
  try {
    const clinicName = clinic?.name ?? 'the clinic';
    const { readableTime, readableDate } = formatInTimezone(startAtDate, timezone);
    const phone = patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`;
    const firstName = patientName.split(' ')[0];

    await sendSMS(phone,
      `Hi ${firstName}, your appointment at ${clinicName} has been confirmed for ` +
      `${readableDate} at ${readableTime} (${reason}). ` +
      `Please call us if you need to reschedule. Do not reply to this message.`
    );
    console.log('Booking confirmation SMS sent ✓');
  } catch (err: any) {
    console.warn('Booking confirmation SMS failed (non-fatal):', err?.message);
  }

  // ── Schedule 60-min reminder + feedback SMS ────────────────────────────────
  try {
    await scheduleReminders(
      appointment.id,
      patientPhone,
      patientName,
      clinic?.name ?? 'the clinic',
      startAtDate
    );
    console.log('Reminders scheduled ✓');
  } catch (err: any) {
    console.warn('Reminder scheduling failed (non-fatal):', err?.message);
  }

  const readableTime = toReadableTime(hour, min);
  const firstName = patientName.split(' ')[0];

  return `Booked. Say EXACTLY: "You are all set, ${firstName}. See you on ${readableTime} — we will send a reminder. Is there anything else I can help you with today?" If no or bye say "Take care, have a great day" and end the call.`;
}
