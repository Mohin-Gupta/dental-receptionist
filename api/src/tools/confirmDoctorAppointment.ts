import { prisma } from '../lib/prisma';
import { sendSMS } from '../services/twilio';
import { placeOutboundCall } from '../services/vapiOutbound';
import { cancelReminders, scheduleReminders } from '../queues/reminderQueue';
import { normalizeTime, toReadableTime, toReadableDate } from './helpers';
import {
  deleteCalendarEvent,
  createCalendarEvent,
  toISTString,
  addMinutesToISTString,
} from '../services/googleCalendar';

function utcToIST(utcDate: Date): { h: number; m: number; year: number; month: number; day: number } {
  const istMs = utcDate.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return {
    h: ist.getUTCHours(),
    m: ist.getUTCMinutes(),
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
  };
}

function formatReadable(utcDate: Date): { readableTime: string; readableDate: string } {
  const { h, m, month, day } = utcToIST(utcDate);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'];
  return {
    readableTime: `${hour12}${minuteStr} ${period}`,
    readableDate: `${monthNames[month - 1]} ${day}`,
  };
}

export async function confirmDoctorAppointment(
  clinicId: string,
  parameters: any
): Promise<string> {
  const { appointmentId, status, newTime } = parameters;

  console.log('=== DOCTOR CONFIRMATION ===', { appointmentId, status, newTime });

  const cleanId = (appointmentId ?? '').replace(/['"]/g, '').trim();

  const appointment = await prisma.appointment.findUnique({
    where: { id: cleanId },
    include: { patient: true, clinic: true },
  });

  if (!appointment) {
    console.error('Appointment not found:', cleanId);
    return 'Appointment not found.';
  }

  const patientPhone = appointment.patient.phone;
  const phone = patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`;
  const firstName = appointment.patient.name.split(' ')[0];
  const { readableTime, readableDate } = formatReadable(appointment.startAt);
  const clinicName = appointment.clinic.name;

  // ── Doctor confirmed — send patient reminder ──────────────────────────────
  if (status === 'confirmed') {
    console.log('Doctor confirmed — sending patient reminder');

    try {
      await placeOutboundCall(
        phone,
        process.env.VAPI_REMINDER_ASSISTANT_ID!,
        {
          patientName: firstName,
          clinicName,
          appointmentTime: readableTime,
          appointmentDate: readableDate,
        }
      );
      console.log('Patient reminder call placed ✓');
    } catch (err: any) {
      console.error('Reminder call failed — sending SMS:', err?.message);
      await sendSMS(phone,
        `Hi ${firstName}, reminder from ${clinicName}: ` +
        `your appointment is today at ${readableTime}. ` +
        `To reschedule please call us. Do not reply to this message.`
      );
    }

    return 'Confirmed. Patient reminder sent.';
  }

  // ── Doctor cancelled — notify patient ─────────────────────────────────────
  if (status === 'cancelled') {
    console.log('Doctor cancelled — notifying patient');

    if (appointment.googleEventId) {
      try {
        await deleteCalendarEvent(clinicId, appointment.googleEventId);
        console.log('Calendar event deleted ✓');
      } catch (err: any) {
        console.warn('Calendar delete failed:', err?.message);
      }
    }

    await prisma.appointment.update({
      where: { id: cleanId },
      data: { status: 'cancelled' },
    });

    await cancelReminders(cleanId);

    // SMS patient
    await sendSMS(phone,
      `Hi ${firstName}, we are sorry to inform you that your appointment ` +
      `at ${clinicName} on ${readableDate} at ${readableTime} ` +
      `has been cancelled by the clinic. ` +
      `Please call us to rebook at your convenience. ` +
      `Do not reply to this message.`
    );

    // Also try calling patient
    try {
      await placeOutboundCall(
        phone,
        process.env.VAPI_REMINDER_ASSISTANT_ID!,
        {
          patientName: firstName,
          clinicName,
          appointmentTime: readableTime,
          appointmentDate: readableDate,
        }
      );
    } catch (err: any) {
      console.warn('Patient cancel call failed (SMS already sent):', err?.message);
    }

    console.log('Patient notified of cancellation ✓');
    return 'Cancelled. Patient notified via SMS and call.';
  }

  // ── Doctor wants to reschedule ────────────────────────────────────────────
  if (status === 'reschedule' && newTime) {
    console.log('Doctor rescheduling to:', newTime);

    const finalTime = normalizeTime(newTime);
    const { year, month, day } = utcToIST(appointment.startAt);
    const [hour, min] = finalTime.split(':').map(Number);

    const startAtIST = toISTString(year, month, day, hour, min);
    const endAtIST = addMinutesToISTString(startAtIST, 30);
    const startAtDate = new Date(startAtIST);
    const endAtDate = new Date(endAtIST);

    if (isNaN(startAtDate.getTime())) {
      return 'Could not parse new time. Please try again with HH:MM format.';
    }

    // Delete old calendar event
    if (appointment.googleEventId) {
      try {
        await deleteCalendarEvent(clinicId, appointment.googleEventId);
      } catch (err: any) {
        console.warn('Old event delete failed:', err?.message);
      }
    }

    // Cancel old appointment
    await prisma.appointment.update({
      where: { id: cleanId },
      data: { status: 'cancelled' },
    });

    // Create new calendar event
    const googleEventId = await createCalendarEvent(clinicId, {
      patientName: appointment.patient.name,
      patientPhone: patientPhone,
      reason: appointment.reason,
      startAt: startAtIST,
      endAt: endAtIST,
    });

    // Create new appointment
    const newAppointment = await prisma.appointment.create({
      data: {
        clinicId,
        patientId: appointment.patientId,
        reason: appointment.reason,
        startAt: startAtDate,
        endAt: endAtDate,
        status: 'scheduled',
        googleEventId,
      },
    });

    // Cancel old reminders, schedule new ones
    await cancelReminders(cleanId);
    await scheduleReminders(
      newAppointment.id,
      patientPhone,
      appointment.patient.name,
      clinicName,
      startAtDate
    );

    const newReadableTime = toReadableTime(hour, min);

    // SMS patient about reschedule
    await sendSMS(phone,
      `Hi ${firstName}, your appointment at ${clinicName} ` +
      `on ${readableDate} has been rescheduled to ${newReadableTime}. ` +
      `Please call us if this time does not work for you. ` +
      `Do not reply to this message.`
    );

    console.log('Appointment rescheduled and patient notified ✓');
    return `Rescheduled to ${newReadableTime}. Patient notified via SMS.`;
  }

  return 'Invalid status. Use confirmed, cancelled, or reschedule.';
}