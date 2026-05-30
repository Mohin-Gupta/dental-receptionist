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
              result = `No available slots on ${parameters.date}. The clinic is closed or fully booked. Ask the patient to choose a different date.`;
            } else {
              slotCache[callId] = {
                date: parameters.date,
                slots: slots.map(s => ({ start: s.start, label: s.label })),
              };

              const first4 = slots.slice(0, 4).map(s => s.label).join('... ');
              const totalSlots = slots.length;
              const lastSlot = slots[totalSlots - 1].label;

              result = `We have ${totalSlots} slots available on ${parameters.date}. First available: ${first4}. ${totalSlots > 4 ? `More slots available up to ${lastSlot}.` : ''} Read first 4 to patient one at a time. If patient asks for a specific time use validateSlot.`;
            }
          } catch (err: any) {
            console.error('checkAvailability error:', err?.message ?? err);
            result = 'Unable to check availability. Please apologise and ask patient to try again.';
          }
        }

        // ── Validate a specific slot ──
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
            console.log(`Validating slot: ${date} ${normalized}`);

            let isAvailable = false;
            const cached = slotCache[callId];

            if (cached && cached.date === date) {
              isAvailable = cached.slots.some(s => s.start === normalized);
            } else {
              const slots = await getAvailableSlots(clinicId, date);
              slots.sort((a, b) => {
                const [aH, aM] = a.start.split(':').map(Number);
                const [bH, bM] = b.start.split(':').map(Number);
                return (aH * 60 + aM) - (bH * 60 + bM);
              });
              slotCache[callId] = {
                date,
                slots: slots.map(s => ({ start: s.start, label: s.label })),
              };
              isAvailable = slots.some(s => s.start === normalized);
            }

            const [h, m] = normalized.split(':').map(Number);
            const period = h >= 12 ? 'PM' : 'AM';
            const hour12 = h % 12 === 0 ? 12 : h % 12;
            const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
            const readableTime = `${hour12}${minuteStr} ${period}`;

            if (isAvailable) {
              result = `${readableTime} on ${date} is available. Confirm this time with the patient, then collect their name and phone number. Use time="${normalized}" when calling bookAppointment or confirmDetails.`;
              console.log(`Slot ${normalized} available ✓`);
            } else {
              const suggestions = slotCache[callId]?.slots.slice(0, 3).map(s => s.label).join(', ') ?? '';
              result = `${readableTime} on ${date} is not available. ${suggestions ? `Nearest available: ${suggestions}.` : ''} Ask patient if any of these work.`;
              console.log(`Slot ${normalized} NOT available`);
            }
          } catch (err: any) {
            console.error('validateSlot error:', err?.message ?? err);
            result = 'Unable to validate that slot. Ask patient to choose from available times.';
          }
        }

        // ── Confirm details — backend reads back exactly ──
        if (name === 'confirmDetails') {
          try {
            const { patientName, patientPhone, date, time } = parameters;
            const reason = (parameters.reason && parameters.reason.trim() !== '')
              ? parameters.reason.trim()
              : 'General visit';

            // Store confirmed details
            confirmedDetails[callId] = {
              patientName,
              patientPhone,
              date,
              time,
              reason,
            };

            // Format phone digit by digit
            const phoneDigits = patientPhone
              .replace(/\D/g, '')
              .split('')
              .join('. ');

            // Format time
            const [h, m] = time.split(':').map(Number);
            const period = h >= 12 ? 'PM' : 'AM';
            const hour12 = h % 12 === 0 ? 12 : h % 12;
            const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
            const readableTime = `${hour12}${minuteStr} ${period}`;

            // Format date
            const [year, month, day] = date.split('-').map(Number);
            const monthNames = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];
            const readableDate = `${monthNames[month - 1]} ${day}`;

            console.log(`Details confirmed for ${callId}:`, confirmedDetails[callId]);

            result = `Read this EXACTLY to the patient, word for word: "Just to confirm. Your name is ${patientName}. Your phone number is ${phoneDigits}. You are booked for ${reason} on ${readableDate} at ${readableTime}. Is all of this correct?"`;

          } catch (err: any) {
            console.error('confirmDetails error:', err?.message ?? err);
            result = 'Please ask the patient to confirm their name, number, date and time.';
          }
        }

        // ── Book appointment ──
        if (name === 'bookAppointment') {
          console.log('=== BOOK APPOINTMENT CALLED ===');

          try {
            // Always prefer confirmed details — never trust LLM to pass correct values
            const confirmed = confirmedDetails[callId];

            const patientName = confirmed?.patientName ?? parameters.patientName;
            const patientPhone = (confirmed?.patientPhone ?? parameters.patientPhone).replace(/\D/g, '');
            const date = confirmed?.date ?? parameters.date;
            const time = confirmed?.time ?? parameters.time;
            const reason = confirmed?.reason ?? parameters.reason ?? 'General visit';

            console.log('Booking with confirmed details:', { patientName, patientPhone, date, time, reason });

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
            console.log(`Final time: "${time}" → "${finalTime}"`);

            const [year, month, day] = date.split('-').map(Number);
            const [hour, min] = finalTime.split(':').map(Number);

            const startAtIST = toISTString(year, month, day, hour, min);
            const endAtIST = addMinutesToISTString(startAtIST, 30);

            console.log('startAt (IST):', startAtIST);
            console.log('endAt   (IST):', endAtIST);

            const startAtDate = new Date(startAtIST);
            const endAtDate = new Date(endAtIST);

            if (isNaN(startAtDate.getTime())) {
              throw new Error(`Invalid date: date=${date} time=${finalTime}`);
            }

            let patient = await prisma.patient.findUnique({
              where: { clinicId_phone: { clinicId, phone: patientPhone } },
            });

            if (!patient) {
              patient = await prisma.patient.create({
                data: { clinicId, name: patientName, phone: patientPhone },
              });
              console.log('New patient created ✓', patient.id);
            } else {
              await prisma.patient.update({
                where: { id: patient.id },
                data: { name: patientName },
              });
              console.log('Existing patient updated ✓', patient.id);
            }

            const googleEventId = await createCalendarEvent(clinicId, {
              patientName,
              patientPhone,
              reason,
              startAt: startAtIST,
              endAt: endAtIST,
            });

            console.log('Google Calendar event created ✓', googleEventId);

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

            const period = hour >= 12 ? 'PM' : 'AM';
            const hour12 = hour % 12 === 0 ? 12 : hour % 12;
            const minuteStr = min === 0 ? '' : `:${min.toString().padStart(2, '0')}`;
            const readableTime = `${hour12}${minuteStr} ${period}`;

            result = `Appointment successfully confirmed. Tell the patient exactly: "Your appointment is confirmed for ${readableTime} on ${date}. You will receive a reminder before your appointment."`;

          } catch (err: any) {
            console.error('=== BOOKING FAILED ===');
            console.error('Error:', err?.message);
            console.error('Stack:', err?.stack);
            result = 'There was a technical issue. Tell the patient: "Your appointment request has been noted and a team member will call you back shortly to confirm."';
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
      }

      console.log('Call ID:', call?.id);
      console.log('Duration:', call?.duration);

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
        console.error('=== CALL LOG SAVE FAILED ===');
        console.error('Error:', err?.message);
        console.error('Code:', err?.code);
      }
    }

    if (type === 'status-update') {
      console.log('Status update:', event.message?.status);
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;