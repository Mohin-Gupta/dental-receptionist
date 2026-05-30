import { prisma } from '../lib/prisma';
import { createCalendarEvent, toISTString, addMinutesToISTString } from '../services/googleCalendar';
import { slotCache, confirmedDetails, nameCache, clearCallState } from './state';
import { normalizeTime, toReadableTime } from './helpers';

export async function bookAppointment(
  clinicId: string,
  callId: string,
  parameters: any
): Promise<string> {
  const confirmed = confirmedDetails[callId];
  const patientName = nameCache[callId] ?? confirmed?.patientName ?? parameters.patientName;
  const patientPhone = (confirmed?.patientPhone ?? parameters.patientPhone ?? '').replace(/\D/g, '');
  const date = confirmed?.date ?? parameters.date;
  const time = confirmed?.time ?? parameters.time;
  const reason = confirmed?.reason ?? parameters.reason ?? 'General visit';

  console.log('Booking:', { patientName, patientPhone, date, time, reason });

  const finalTime = normalizeTime(time);
  const [year, month, day] = date.split('-').map(Number);
  const [hour, min] = finalTime.split(':').map(Number);

  const startAtIST = toISTString(year, month, day, hour, min);
  const endAtIST = addMinutesToISTString(startAtIST, 30);
  const startAtDate = new Date(startAtIST);
  const endAtDate = new Date(endAtIST);

  if (isNaN(startAtDate.getTime())) throw new Error(`Invalid date: ${date} ${finalTime}`);

  let patient = await prisma.patient.findUnique({
    where: { clinicId_phone: { clinicId, phone: patientPhone } },
  });

  if (!patient) {
    patient = await prisma.patient.create({
      data: { clinicId, name: patientName, phone: patientPhone },
    });
  } else {
    await prisma.patient.update({
      where: { id: patient.id },
      data: { name: patientName },
    });
  }

  const googleEventId = await createCalendarEvent(clinicId, {
    patientName, patientPhone, reason,
    startAt: startAtIST, endAt: endAtIST,
  });

  const appointment = await prisma.appointment.create({
    data: {
      clinicId, patientId: patient.id, reason,
      startAt: startAtDate, endAt: endAtDate,
      status: 'scheduled', googleEventId,
    },
  });

  clearCallState(callId);
  console.log('Booked ✓', appointment.id);

  const readableTime = toReadableTime(hour, min);
  const firstName = patientName.split(' ')[0];

  return `Booked. Say EXACTLY: "You are all set, ${firstName}. See you on ${readableTime} — we will send a reminder. Is there anything else I can help you with today?" If no or bye say "Take care, have a great day" and end the call.`;
}