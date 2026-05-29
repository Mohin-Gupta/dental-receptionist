import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { getAvailableSlots, createCalendarEvent } from '../services/googleCalendar';

const router = Router();

router.post('/webhook/vapi', async (req, res) => {
  const event = req.body;
  const type = event?.message?.type;

  console.log('Vapi event:', type);

  try {

    // ── Tool calls from the AI mid-conversation ──
    if (type === 'tool-calls') {
      const toolCallList = event.message.toolCallList;
      const clinicId = process.env.DEFAULT_CLINIC_ID!;
      const results = [];

      for (const toolCall of toolCallList) {
        const name = toolCall.function.name;
        const rawArgs = toolCall.function.arguments;
        const parameters = typeof rawArgs === 'string'
          ? JSON.parse(rawArgs)
          : rawArgs ?? {};

        console.log(`Tool called: ${name}`, parameters);

        let result = '';

        // ── Check availability ──
        if (name === 'checkAvailability') {
          try {
            console.log('Checking availability for date:', parameters.date);
            const slots = await getAvailableSlots(clinicId, parameters.date);
            console.log('Slots found:', slots);

            if (slots.length === 0) {
              result = `No available slots on ${parameters.date}. The clinic may be closed or fully booked. Please ask the patient to choose another date.`;
            } else {
              const formatTime = (time: string) => {
                const [h, m] = time.split(':').map(Number);
                const period = h >= 12 ? 'PM' : 'AM';
                const hour = h % 12 === 0 ? 12 : h % 12;
                const minute = m === 0 ? '00' : m.toString().padStart(2, '0');
                return `${hour}:${minute} ${period}`;
              };

              const formatted = slots
                .slice(0, 6)
                .map((s) => formatTime(s.start))
                .join(', ');

              result = `We have the following slots available on ${parameters.date}: ${formatted}. Which time works best for you?`;
            }
          } catch (err: any) {
            console.error('checkAvailability error:', err?.message ?? err);
            result = 'Unable to check availability right now. Please ask the patient for a preferred time and try booking directly.';
          }
        }

        // ── Book appointment ──
        if (name === 'bookAppointment') {
          console.log('=== BOOK APPOINTMENT CALLED ===');
          console.log('Raw parameters:', JSON.stringify(parameters, null, 2));

          try {
            const { patientName, patientPhone, reason, date, time } = parameters;

            // Convert time to 24-hour format (handles both "14:00" and "2:00 PM")
            const convertTo24Hour = (timeStr: string): { hour: number; min: number } => {
              const cleaned = timeStr.trim().toUpperCase();

              if (cleaned.includes('AM') || cleaned.includes('PM')) {
                // 12-hour format e.g. "12:00 PM", "9:30 AM"
                const [timePart, period] = cleaned.split(' ');
                let [h, m] = timePart.split(':').map(Number);
                if (period === 'AM' && h === 12) h = 0;
                if (period === 'PM' && h !== 12) h += 12;
                return { hour: h, min: m || 0 };
              } else {
                // 24-hour format e.g. "14:00"
                const [h, m] = timeStr.split(':').map(Number);
                return { hour: h, min: m || 0 };
              }
            };

            const { hour, min } = convertTo24Hour(time);
            const [year, month, day] = date.split('-').map(Number);

            const startAt = new Date(year, month - 1, day, hour, min, 0, 0);
            const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

            console.log('Parsed time:', { hour, min });
            console.log('startAt:', startAt.toISOString());
            console.log('endAt:', endAt.toISOString());

            // Find or create patient
            let patient = await prisma.patient.findUnique({
              where: {
                clinicId_phone: { clinicId, phone: patientPhone },
              },
            });

            if (!patient) {
              patient = await prisma.patient.create({
                data: {
                  clinicId,
                  name: patientName,
                  phone: patientPhone,
                },
              });
              console.log('New patient created ✓', patient.id);
            }

            // Create Google Calendar event
            const googleEventId = await createCalendarEvent(clinicId, {
              patientName,
              patientPhone,
              reason,
              startAt: startAt.toISOString(),
              endAt: endAt.toISOString(),
            });

            console.log('Google Calendar event created ✓', googleEventId);

            // Save appointment to database
            const appointment = await prisma.appointment.create({
              data: {
                clinicId,
                patientId: patient.id,
                reason,
                startAt,
                endAt,
                status: 'scheduled',
                googleEventId,
              },
            });

            console.log('Appointment booked ✓', appointment.id);
            result = `Appointment confirmed for ${patientName} on ${date} at ${time} for ${reason}. It has been added to the calendar. Please confirm these details to the patient clearly.`;

          } catch (err: any) {
            console.error('=== BOOKING FAILED ===');
            console.error('Error message:', err?.message);
            console.error('Error stack:', err?.stack);
            result = 'There was an issue booking the appointment. Please let the patient know a staff member will call them back to confirm.';
          }
        }

        results.push({
          toolCallId: toolCall.id,
          result,
        });
      }

      return res.json({ results });
    }

    // ── Save call log when call ends ──
    if (type === 'end-of-call-report') {
      const call = event.message.call;
      const transcript = event.message.transcript ?? [];

      await prisma.callLog.create({
        data: {
          clinicId: process.env.DEFAULT_CLINIC_ID!,
          vapiCallId: call.id,
          direction: 'inbound',
          durationSecs: Math.round(call.duration ?? 0),
          transcript,
          outcome: 'completed',
        },
      });

      console.log('Call log saved ✓');
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;