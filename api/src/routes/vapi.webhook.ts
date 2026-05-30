import { Router } from 'express';
import { prisma } from '../lib/prisma';
import {
  getAvailableSlots,
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  toISTString,
  addMinutesToISTString,
} from '../services/googleCalendar';

const router = Router();

const slotCache: Record<string, {
  date: string;
  slots: { start: string; label: string }[];
}> = {};

const confirmedDetails: Record<string, {
  patientName: string;
  patientPhone: string;
  date: string;
  time: string;
  reason: string;
}> = {};

const nameCache: Record<string, string> = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTime(t: string): string {
  const cleaned = t.trim().toUpperCase();
  if (cleaned.includes('AM') || cleaned.includes('PM')) {
    const parts = cleaned.split(' ');
    const timePart = parts[0];
    const period = parts[1];
    const [hStr, mStr] = timePart.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr ? parseInt(mStr, 10) : 0;
    if (period === 'AM' && h === 12) h = 0;
    if (period === 'PM' && h !== 12) h += 12;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const m = mStr ? parseInt(mStr, 10) : 0;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function toReadableTime(h: number, m: number): string {
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
  return `${hour12}${minuteStr} ${period}`;
}

function toReadableDate(dateStr: string): string {
  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${monthNames[month - 1]} ${day}`;
}

function utcToISTReadable(utcDate: Date): { readableDate: string; readableTime: string } {
  const istMs = utcDate.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return {
    readableDate: `${monthNames[ist.getUTCMonth()]} ${ist.getUTCDate()}`,
    readableTime: toReadableTime(h, m),
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

router.post('/webhook/vapi', async (req, res) => {
  const event = req.body;
  const type = event?.message?.type;

  console.log('Vapi event:', type);

  try {

    if (type === 'tool-calls') {
      const toolCallList = event.message.toolCallList;
      const clinicId = process.env.DEFAULT_CLINIC_ID!;
      const callId = event.message.call?.id ?? 'unknown';
      const results = [];

      for (const toolCall of toolCallList) {
        const name = toolCall.function.name;
        const rawArgs = toolCall.function.arguments;
        const parameters = typeof rawArgs === 'string'
          ? JSON.parse(rawArgs)
          : rawArgs ?? {};

        console.log(`Tool called: ${name}`, JSON.stringify(parameters, null, 2));

        let result = '';

        // ── checkAvailability ──────────────────────────────────────────────
        if (name === 'checkAvailability') {
          try {
            // Enforce 7-day booking limit
            const requestedDate = new Date(parameters.date + 'T00:00:00+05:30');
            const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
            const diffDays = Math.floor(
              (requestedDate.getTime() - nowIST.getTime()) / (1000 * 60 * 60 * 24)
            );

            if (diffDays > 7) {
              const callBackDate = new Date(requestedDate.getTime() - 7 * 24 * 60 * 60 * 1000);
              const callBackReadable = callBackDate.toLocaleDateString('en-IN', {
                weekday: 'long', month: 'long', day: 'numeric'
              });
              result = `Date is more than 7 days away. Say: "We only book up to a week in advance. Please call us back around ${callBackReadable} and we will get you sorted."`;
            } else {
              const slots = await getAvailableSlots(clinicId, parameters.date);

              slots.sort((a, b) => {
                const [aH, aM] = a.start.split(':').map(Number);
                const [bH, bM] = b.start.split(':').map(Number);
                return (aH * 60 + aM) - (bH * 60 + bM);
              });

              if (slots.length === 0) {
                result = `No slots available on ${parameters.date}. Ask patient to choose another date.`;
              } else {
                slotCache[callId] = {
                  date: parameters.date,
                  slots: slots.map(s => ({ start: s.start, label: s.label })),
                };

                const first4 = slots.slice(0, 4).map(s => s.label).join(', ');
                const lastSlot = slots[slots.length - 1].label;
                const total = slots.length;

                result = `${total} slots on ${parameters.date}. First 4: ${first4}.${total > 4 ? ` More up to ${lastSlot}.` : ''} Read first 4 naturally. Use validateSlot for specific time requests.`;
              }
            }
          } catch (err: any) {
            console.error('checkAvailability error:', err?.message);
            result = 'Cannot check availability. Apologise and ask patient to try again.';
          }
        }

        // ── validateSlot ───────────────────────────────────────────────────
        if (name === 'validateSlot') {
          try {
            const { date, time } = parameters;
            const normalized = normalizeTime(time);

            let allSlots = slotCache[callId]?.slots ?? [];
            if (!slotCache[callId] || slotCache[callId].date !== date) {
              const fetched = await getAvailableSlots(clinicId, date);
              fetched.sort((a, b) => {
                const [aH, aM] = a.start.split(':').map(Number);
                const [bH, bM] = b.start.split(':').map(Number);
                return (aH * 60 + aM) - (bH * 60 + bM);
              });
              slotCache[callId] = { date, slots: fetched.map(s => ({ start: s.start, label: s.label })) };
              allSlots = slotCache[callId].slots;
            }

            const isAvailable = allSlots.some(s => s.start === normalized);
            const [h, m] = normalized.split(':').map(Number);
            const readableTime = toReadableTime(h, m);

            if (isAvailable) {
              result = `${readableTime} is available. Confirm with patient then proceed. Use time="${normalized}" for booking.`;
            } else {
              const requestedMins = h * 60 + m;
              const nearby = allSlots
                .map(s => {
                  const [sh, sm] = s.start.split(':').map(Number);
                  return { ...s, diff: Math.abs(sh * 60 + sm - requestedMins) };
                })
                .filter(s => s.diff > 0 && s.diff <= 90)
                .sort((a, b) => a.diff - b.diff)
                .slice(0, 2);

              const suggestions = nearby.length > 0
                ? nearby.map(s => s.label).join(' or ')
                : allSlots.slice(0, 2).map(s => s.label).join(' or ');

              result = `${readableTime} is not available. Nearest options: ${suggestions}. Ask which works.`;
            }
          } catch (err: any) {
            console.error('validateSlot error:', err?.message);
            result = 'Cannot validate slot. Ask patient to choose from available times.';
          }
        }

        // ── storeName ──────────────────────────────────────────────────────
        if (name === 'storeName') {
          try {
            const { letters } = parameters;
            const cleanLetters = letters
              .trim()
              .toUpperCase()
              .replace(/\bSPACE\b/gi, '|')
              .replace(/[^A-Z|]/g, '')
              .split('|')
              .map((word: string) => {
                if (word.length === 0) return '';
                return word[0].toUpperCase() + word.slice(1).toLowerCase();
              })
              .filter((w: string) => w.length > 0)
              .join(' ')
              .trim();

            nameCache[callId] = cleanLetters;
            console.log(`Name stored: "${letters}" → "${cleanLetters}"`);
            result = `Name stored as "${cleanLetters}". Say: "Got it — ${cleanLetters}. Is that right?" If yes proceed. If no ask to spell again and call storeName.`;
          } catch (err: any) {
            console.error('storeName error:', err?.message);
            result = 'Could not store name. Ask patient to spell again.';
          }
        }

        // ── confirmDetails ─────────────────────────────────────────────────
        if (name === 'confirmDetails') {
          try {
            const { patientPhone, date, time } = parameters;
            const reason = parameters.reason?.trim() || 'General visit';
            const patientName = nameCache[callId] ?? parameters.patientName ?? 'Patient';
            const cleanPhone = patientPhone.replace(/\D/g, '');
            const last4 = cleanPhone.slice(-4);

            if (!/^\d{4}$/.test(last4)) {
              result = 'Phone number seems incorrect. Ask patient to confirm their number.';
            } else {
              confirmedDetails[callId] = { patientName, patientPhone: cleanPhone, date, time, reason };

              const [h, m] = time.split(':').map(Number);
              const readableTime = toReadableTime(h, m);
              const readableDate = toReadableDate(date);

              console.log(`Confirmed: ${patientName}, ***${last4}, ${reason}, ${readableDate} ${readableTime}`);
              result = `Say EXACTLY: "Perfect — ${patientName}, number ending in ${last4}, ${reason} on ${readableDate} at ${readableTime}. Does that sound right?"`;
            }
          } catch (err: any) {
            console.error('confirmDetails error:', err?.message);
            result = 'Please confirm booking details with the patient.';
          }
        }

        // ── findAppointment ────────────────────────────────────────────────
        if (name === 'findAppointment') {
          try {
            const searchName = (parameters.patientName ?? '').trim();

            if (!searchName) {
              result = 'No name provided. Ask for the patient name.';
            } else {
              const patients = await prisma.patient.findMany({
                where: {
                  clinicId,
                  name: { contains: searchName, mode: 'insensitive' },
                },
              });

              if (patients.length === 0) {
                result = `No patient found named "${searchName}". Ask them to confirm the name they booked under or spell it again.`;
              } else {
                const appointments = await prisma.appointment.findMany({
                  where: {
                    clinicId,
                    patientId: { in: patients.map(p => p.id) },
                    status: { in: ['scheduled', 'confirmed'] },
                    startAt: { gte: new Date() },
                  },
                  include: { patient: true },
                  orderBy: { startAt: 'asc' },
                  take: 5,
                });

                if (appointments.length === 0) {
                  result = `No upcoming appointments found for "${searchName}". They may have no future bookings.`;
                } else if (appointments.length === 1) {
                  const a = appointments[0];
                  const { readableDate, readableTime } = utcToISTReadable(a.startAt);
                  result = `Found: appointmentId="${a.id}" — ${a.patient.name}, ${a.reason} on ${readableDate} at ${readableTime}. Say: "I found a ${a.reason} on ${readableDate} at ${readableTime} — is that the one?" If yes use appointmentId="${a.id}" for next step.`;
                } else {
                  const list = appointments.map(a => {
                    const { readableDate, readableTime } = utcToISTReadable(a.startAt);
                    return `appointmentId="${a.id}" — ${a.reason} on ${readableDate} at ${readableTime}`;
                  }).join('. ');
                  result = `Found ${appointments.length} appointments: ${list}. Ask patient which one they mean and use the correct appointmentId.`;
                }
              }
            }
          } catch (err: any) {
            console.error('findAppointment error:', err?.message);
            result = 'Could not look up appointments. Ask patient to try again.';
          }
        }

        // ── cancelAppointment ──────────────────────────────────────────────
        if (name === 'cancelAppointment') {
          try {
            const { appointmentId } = parameters;

            const appointment = await prisma.appointment.findUnique({
              where: { id: appointmentId },
              include: { patient: true },
            });

            if (!appointment) {
              result = 'Appointment not found. Ask patient to confirm the details.';
            } else {
              // Delete from Google Calendar
              if (appointment.googleEventId) {
                try {
                  await deleteCalendarEvent(clinicId, appointment.googleEventId);
                } catch (calErr: any) {
                  console.warn('Calendar delete failed (continuing):', calErr?.message);
                }
              }

              // Update DB status
              await prisma.appointment.update({
                where: { id: appointmentId },
                data: { status: 'cancelled' },
              });

              const { readableDate, readableTime } = utcToISTReadable(appointment.startAt);
              const firstName = appointment.patient.name.split(' ')[0];

              console.log(`Appointment cancelled ✓ ${appointmentId}`);
              result = `Cancelled. Say EXACTLY: "Done — your ${appointment.reason} appointment on ${readableDate} at ${readableTime} has been cancelled, ${firstName}. Hope to see you again soon. Take care." Then end the call.`;
            }
          } catch (err: any) {
            console.error('cancelAppointment error:', err?.message);
            result = 'Could not cancel. Tell patient a team member will call them back to confirm.';
          }
        }

        // ── rescheduleAppointment ──────────────────────────────────────────
        if (name === 'rescheduleAppointment') {
          try {
            const { appointmentId, newDate, newTime } = parameters;

            const appointment = await prisma.appointment.findUnique({
              where: { id: appointmentId },
              include: { patient: true },
            });

            if (!appointment) {
              result = 'Appointment not found. Ask patient to confirm details.';
            } else {
              const finalTime = normalizeTime(newTime);
              const [year, month, day] = newDate.split('-').map(Number);
              const [hour, min] = finalTime.split(':').map(Number);

              const startAtIST = toISTString(year, month, day, hour, min);
              const endAtIST = addMinutesToISTString(startAtIST, 30);
              const startAtDate = new Date(startAtIST);
              const endAtDate = new Date(endAtIST);

              if (isNaN(startAtDate.getTime())) {
                throw new Error(`Invalid date: ${newDate} ${finalTime}`);
              }

              // Update Google Calendar
              if (appointment.googleEventId) {
                try {
                  await updateCalendarEvent(clinicId, appointment.googleEventId, {
                    startAt: startAtIST,
                    endAt: endAtIST,
                  });
                } catch (calErr: any) {
                  console.warn('Calendar update failed (continuing):', calErr?.message);
                }
              }

              // Update DB
              await prisma.appointment.update({
                where: { id: appointmentId },
                data: {
                  startAt: startAtDate,
                  endAt: endAtDate,
                  status: 'scheduled',
                },
              });

              const readableTime = toReadableTime(hour, min);
              const readableDate = toReadableDate(newDate);
              const firstName = appointment.patient.name.split(' ')[0];

              console.log(`Appointment rescheduled ✓ ${appointmentId} → ${newDate} ${finalTime}`);
              result = `Rescheduled. Say EXACTLY: "All done, ${firstName}. Your ${appointment.reason} appointment has been moved to ${readableDate} at ${readableTime}. We will send you a reminder. Take care." Then end the call.`;
            }
          } catch (err: any) {
            console.error('rescheduleAppointment error:', err?.message);
            result = 'Could not reschedule. Tell patient a team member will call them back to confirm.';
          }
        }

        // ── bookAppointment ────────────────────────────────────────────────
        if (name === 'bookAppointment') {
          console.log('=== BOOK APPOINTMENT CALLED ===');
          try {
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

            if (isNaN(startAtDate.getTime())) {
              throw new Error(`Invalid date: ${date} ${finalTime}`);
            }

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
                clinicId,
                patientId: patient.id,
                reason,
                startAt: startAtDate,
                endAt: endAtDate,
                status: 'scheduled',
                googleEventId,
              },
            });

            console.log('Appointment booked ✓', appointment.id);
            delete slotCache[callId];
            delete confirmedDetails[callId];
            delete nameCache[callId];

            const readableTime = toReadableTime(hour, min);
            const firstName = patientName.split(' ')[0];

            result = `Booked. Say EXACTLY: "You are all set, ${firstName}. See you on ${readableTime} — we will send a reminder. Is there anything else I can help you with today?" If no or bye say "Take care, have a great day" and end the call.`;

          } catch (err: any) {
            console.error('=== BOOKING FAILED ===', err?.message);
            result = 'Issue booking. Say: "Your request is noted and a team member will call you back. Sorry for the trouble. Take care." Then end the call.';
          }
        }

        results.push({ toolCallId: toolCall.id, result });
      }

      return res.json({ results });
    }

    if (type === 'end-of-call-report') {
      const call = event.message.call;
      const transcript = event.message.transcript ?? [];

      if (call?.id) {
        delete slotCache[call.id];
        delete confirmedDetails[call.id];
        delete nameCache[call.id];
      }

      try {
        const saved = await prisma.callLog.create({
          data: {
            clinicId: process.env.DEFAULT_CLINIC_ID!,
            vapiCallId: call.id,
            direction: 'inbound',
            durationSecs: Math.round(call.duration ?? 0),
            transcript,
            outcome: 'completed',
          },
        });
        console.log('Call log saved ✓', saved.id);
      } catch (err: any) {
        console.error('Call log save failed:', err?.message);
      }
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;