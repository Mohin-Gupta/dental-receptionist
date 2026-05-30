import { Router } from 'express';
import { prisma } from '../lib/prisma';
import {
  getAvailableSlots,
  createCalendarEvent,
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

        // ── Check availability ──
        if (name === 'checkAvailability') {
          try {
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
              const totalSlots = slots.length;
              const lastSlot = slots[totalSlots - 1].label;

              result = `${totalSlots} slots available on ${parameters.date}. First 4: ${first4}.${totalSlots > 4 ? ` More up to ${lastSlot}.` : ''} Read first 4 naturally. Use validateSlot for specific time requests.`;
            }
          } catch (err: any) {
            console.error('checkAvailability error:', err?.message ?? err);
            result = 'Cannot check availability. Apologise and ask patient to try again.';
          }
        }

        // ── Validate slot ──
        if (name === 'validateSlot') {
          try {
            const { date, time } = parameters;

            const normalizeTime = (t: string): string => {
              const cleaned = t.trim().toUpperCase();
              if (cleaned.includes('AM') || cleaned.includes('PM')) {
                const [timePart, period] = cleaned.split(' ');
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
            };

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
            const period = h >= 12 ? 'PM' : 'AM';
            const hour12 = h % 12 === 0 ? 12 : h % 12;
            const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
            const readableTime = `${hour12}${minuteStr} ${period}`;

            if (isAvailable) {
              result = `${readableTime} is available. Confirm with patient then proceed to name. Use time="${normalized}" for booking.`;
            } else {
              const requestedMinutes = h * 60 + m;
              const nearby = allSlots
                .map(s => {
                  const [sh, sm] = s.start.split(':').map(Number);
                  return { ...s, diff: Math.abs(sh * 60 + sm - requestedMinutes) };
                })
                .filter(s => s.diff > 0 && s.diff <= 90)
                .sort((a, b) => a.diff - b.diff)
                .slice(0, 2);

              const suggestions = nearby.length > 0
                ? nearby.map(s => s.label).join(' or ')
                : allSlots.slice(0, 2).map(s => s.label).join(' or ');

              result = `${readableTime} is not available. Nearest options: ${suggestions}. Ask patient which works.`;
            }
          } catch (err: any) {
            console.error('validateSlot error:', err?.message ?? err);
            result = 'Cannot validate that slot. Ask patient to choose from available times.';
          }
        }

        // ── Store name exactly as spelled ──
        if (name === 'storeName') {
          try {
            const { letters } = parameters;

            // Parse spelled letters into a proper name
            // Handles: "M O H I N", "M O H I N space G U P T A", "MOHIN GUPTA"
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

            result = `Name stored as "${cleanLetters}". Say to patient: "Got it — ${cleanLetters}. Is that right?" If yes proceed to phone. If no ask to spell again and call storeName again.`;

          } catch (err: any) {
            console.error('storeName error:', err?.message ?? err);
            result = 'Could not store name. Ask patient to spell it again.';
          }
        }

        // ── Confirm details ──
        if (name === 'confirmDetails') {
          try {
            const { patientPhone, date, time } = parameters;
            const reason = (parameters.reason?.trim()) || 'General visit';

            // Always use nameCache for the name
            const patientName = nameCache[callId] ?? parameters.patientName ?? 'Patient';
            const cleanPhone = patientPhone.replace(/\D/g, '');

            confirmedDetails[callId] = {
              patientName,
              patientPhone: cleanPhone,
              date,
              time,
              reason,
            };

            const [h, m] = time.split(':').map(Number);
            const period = h >= 12 ? 'PM' : 'AM';
            const hour12 = h % 12 === 0 ? 12 : h % 12;
            const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
            const readableTime = `${hour12}${minuteStr} ${period}`;

            const [year, month, day] = date.split('-').map(Number);
            const monthNames = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];
            const readableDate = `${monthNames[month - 1]} ${day}`;

            const last4 = cleanPhone.slice(-4);

            result = `Say this EXACTLY: "Perfect — ${patientName}, number ending in ${last4}, ${reason} on ${readableDate} at ${readableTime}. Does that sound right?"`;

          } catch (err: any) {
            console.error('confirmDetails error:', err?.message ?? err);
            result = 'Please confirm the booking details with the patient.';
          }
        }

        // ── Book appointment ──
        if (name === 'bookAppointment') {
          console.log('=== BOOK APPOINTMENT CALLED ===');

          try {
            const confirmed = confirmedDetails[callId];

            // nameCache is the source of truth for name
            const patientName = nameCache[callId] ?? confirmed?.patientName ?? parameters.patientName;
            const patientPhone = (confirmed?.patientPhone ?? parameters.patientPhone ?? '').replace(/\D/g, '');
            const date = confirmed?.date ?? parameters.date;
            const time = confirmed?.time ?? parameters.time;
            const reason = confirmed?.reason ?? parameters.reason ?? 'General visit';

            console.log('Booking:', { patientName, patientPhone, date, time, reason });

            const normalizeTime = (t: string): string => {
              const cleaned = t.trim().toUpperCase();
              if (cleaned.includes('AM') || cleaned.includes('PM')) {
                const [timePart, period] = cleaned.split(' ');
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
            };

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
              patientName,
              patientPhone,
              reason,
              startAt: startAtIST,
              endAt: endAtIST,
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

            const period = hour >= 12 ? 'PM' : 'AM';
            const hour12 = hour % 12 === 0 ? 12 : hour % 12;
            const minuteStr = min === 0 ? '' : `:${min.toString().padStart(2, '0')}`;
            const readableTime = `${hour12}${minuteStr} ${period}`;
            const firstName = patientName.split(' ')[0];

            result = `Booked. Say EXACTLY: "You are all set, ${firstName}. See you on ${readableTime} — we will send a reminder. Is there anything else I can help you with today?" If patient says no or goodbye, say "Take care, have a great day" and end the call. If patient says yes help them then end the call.`;

          } catch (err: any) {
            console.error('=== BOOKING FAILED ===', err?.message);
            result = 'Booking had an issue. Say: "Your request is noted and a team member will call you back to confirm. Sorry for the trouble. Take care." Then end the call.';
          }
        }

        results.push({ toolCallId: toolCall.id, result });
      }

      return res.json({ results });
    }

    console.log('Processing event type:', type);

    if (type === 'end-of-call-report') {
      console.log('=== END OF CALL REPORT RECEIVED ===');
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
        console.log('Call log saved ✓ ID:', saved.id);
      } catch (err: any) {
        console.error('=== CALL LOG SAVE FAILED ===', err?.message);
      }
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;