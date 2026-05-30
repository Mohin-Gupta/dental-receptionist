import { Router } from 'express';
import { prisma } from '../lib/prisma';
import {
  getAvailableSlots,
  createCalendarEvent,
  toISTString,
  addMinutesToISTString,
} from '../services/googleCalendar';

const router = Router();

// Store slots per call so bookAppointment can validate against them
const slotCache: Record<string, { date: string; slots: { start: string; label: string }[] }> = {};

router.post('/webhook/vapi', async (req, res) => {
  const event = req.body;
  const type = event?.message?.type;

  console.log('Vapi event:', type);

  try {

    // ── Tool calls from the AI mid-conversation ──
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

            if (slots.length === 0) {
              result = `No available slots on ${parameters.date}. The clinic is closed or fully booked. Ask the patient to choose a different date.`;
            } else {
              // Cache all slots for validation
              slotCache[callId] = {
                date: parameters.date,
                slots: slots.slice(0, 8).map(s => ({ start: s.start, label: s.label })),
              };

              // Full mapping for Maya to reference
              const slotTable = slots.slice(0, 8)
                .map(s => `"${s.label}" → use time="${s.start}"`)
                .join(', ');

              // First 6 labels for speaking
              const speakable = slots.slice(0, 6).map(s => s.label).join('... ');
              const totalSlots = slots.length;

              result = `Available slots on ${parameters.date} (${totalSlots} total available): ${speakable}${totalSlots > 6 ? '... and more later in the day' : ''}. Read the first 4 to the patient one at a time. If patient asks for a specific time check this full mapping first: ${slotTable}. STRICT RULE: when booking use ONLY the exact time value from this mapping. Do not convert or modify any time.`;
            }
          } catch (err: any) {
            console.error('checkAvailability error:', err?.message ?? err);
            result = 'Unable to check availability right now. Please ask the patient for a preferred time and try booking directly.';
          }
        }

        // ── Book appointment ──
        if (name === 'bookAppointment') {
          console.log('=== BOOK APPOINTMENT CALLED ===');
          console.log('Parameters:', JSON.stringify(parameters, null, 2));

          try {
            const { patientName, patientPhone, reason, date, time } = parameters;

            // Normalize time — handle any format the LLM sends
            const normalizeTime = (timeStr: string): string => {
              const cleaned = timeStr.trim().toUpperCase();
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
              const [hStr, mStr] = timeStr.split(':');
              const h = parseInt(hStr, 10);
              const m = mStr ? parseInt(mStr, 10) : 0;
              return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
            };

            const normalized = normalizeTime(time);
            console.log(`Time normalized: "${time}" → "${normalized}"`);

            // Validate against cached slots
            const cached = slotCache[callId];
            let finalTime = normalized;

            if (cached && cached.date === date) {
              const match = cached.slots.find(s => s.start === normalized);
              if (!match) {
                console.warn(`Time ${normalized} not in cached slots:`, cached.slots);
                finalTime = cached.slots[0].start;
                console.log(`Falling back to first cached slot: ${finalTime}`);
              } else {
                console.log(`Slot validated ✓ ${normalized}`);
              }
            }

            // Build IST ISO strings directly
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

            // Find or create patient
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

            // Create Google Calendar event
            const googleEventId = await createCalendarEvent(clinicId, {
              patientName,
              patientPhone,
              reason,
              startAt: startAtIST,
              endAt: endAtIST,
            });

            console.log('Google Calendar event created ✓', googleEventId);

            // Save to database
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

            // Human readable time for confirmation
            const period = hour >= 12 ? 'PM' : 'AM';
            const hour12 = hour % 12 === 0 ? 12 : hour % 12;
            const minuteStr = min === 0 ? '' : `:${min.toString().padStart(2, '0')}`;
            const readableTime = `${hour12}${minuteStr} ${period}`;

            result = `Appointment confirmed. Patient: ${patientName}, Phone: ${patientPhone}, Date: ${date}, Time: ${readableTime}, Reason: ${reason}. Tell the patient their appointment is confirmed for ${readableTime} on ${date} and they will receive a reminder.`;

          } catch (err: any) {
            console.error('=== BOOKING FAILED ===');
            console.error('Error:', err?.message);
            console.error('Stack:', err?.stack);
            result = 'There was a problem booking the appointment. Please apologise and let the patient know a staff member will call them back to confirm.';
          }
        }

        results.push({ toolCallId: toolCall.id, result });
      }

      return res.json({ results });
    }

    // ── Save call log when call ends ──
    console.log('Processing event type:', type);

    if (type === 'end-of-call-report') {
      console.log('=== END OF CALL REPORT RECEIVED ===');
      const call = event.message.call;
      const transcript = event.message.transcript ?? [];

      if (call?.id) delete slotCache[call.id];

      console.log('Call ID:', call?.id);
      console.log('Duration:', call?.duration);
      console.log('DEFAULT_CLINIC_ID:', process.env.DEFAULT_CLINIC_ID);

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