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

        console.log(`Tool called: ${name}`, JSON.stringify(parameters, null, 2));

        let result = '';

        // ── Check availability ──
        if (name === 'checkAvailability') {
          try {
            console.log('Checking availability for date:', parameters.date);
            const slots = await getAvailableSlots(clinicId, parameters.date);
            console.log('Slots found:', slots);

            if (slots.length === 0) {
              result = `No available slots on ${parameters.date}. The clinic may be closed or fully booked on that day. Please ask the patient to choose a different date.`;
            } else {
              // Human readable version for Maya to speak
              const formatTime = (time: string) => {
                const [h, m] = time.split(':').map(Number);
                const period = h >= 12 ? 'PM' : 'AM';
                const hour = h % 12 === 0 ? 12 : h % 12;
                const minute = m === 0 ? '00' : m.toString().padStart(2, '0');
                return `${hour}:${minute} ${period}`;
              };

              const speakable = slots
                .slice(0, 4)
                .map((s) => formatTime(s.start))
                .join(', ');

              // 24-hour format for Maya to use when calling bookAppointment
              const bookingFormat = slots
                .slice(0, 4)
                .map((s) => s.start)
                .join(', ');

              result = `Available slots on ${parameters.date}: ${speakable}. Read these to the patient one at a time with a pause between each. When the patient chooses a time, you MUST pass it to bookAppointment in 24-hour format. The 24-hour equivalents are: ${bookingFormat}. Only offer these exact times — do not suggest any other times.`;
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

            // Convert time to 24-hour format — handles "14:00" and "2:00 PM"
            const convertTo24Hour = (timeStr: string): { hour: number; min: number } => {
              const cleaned = timeStr.trim().toUpperCase();

              if (cleaned.includes('AM') || cleaned.includes('PM')) {
                const parts = cleaned.split(' ');
                const timePart = parts[0];
                const period = parts[1];
                const timeSplit = timePart.split(':');
                let h = parseInt(timeSplit[0], 10);
                const m = timeSplit[1] ? parseInt(timeSplit[1], 10) : 0;
                if (period === 'AM' && h === 12) h = 0;
                if (period === 'PM' && h !== 12) h += 12;
                return { hour: h, min: m };
              } else {
                const timeSplit = timeStr.split(':');
                const h = parseInt(timeSplit[0], 10);
                const m = timeSplit[1] ? parseInt(timeSplit[1], 10) : 0;
                return { hour: h, min: m };
              }
            };

            const { hour, min } = convertTo24Hour(time);
            const dateParts = date.split('-').map(Number);
            const year = dateParts[0];
            const month = dateParts[1];
            const day = dateParts[2];

            const startAt = new Date(year, month - 1, day, hour, min, 0, 0);
            const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

            console.log('Parsed:', { patientName, patientPhone, date, time, hour, min });
            console.log('startAt:', startAt.toISOString());
            console.log('endAt:', endAt.toISOString());

            // Validate date parsed correctly
            if (isNaN(startAt.getTime())) {
              throw new Error(`Invalid date/time: date=${date} time=${time} hour=${hour} min=${min}`);
            }

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
            } else {
              // Update name in case it was corrected
              await prisma.patient.update({
                where: { id: patient.id },
                data: { name: patientName },
              });
              console.log('Existing patient found ✓', patient.id);
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

            // Format confirmation time for speaking
            const formatTimeReadable = (d: Date) => {
              const h = d.getHours();
              const m = d.getMinutes();
              const period = h >= 12 ? 'PM' : 'AM';
              const hour = h % 12 === 0 ? 12 : h % 12;
              const minute = m === 0 ? '' : ` ${m}`;
              return `${hour}${minute} ${period}`;
            };

            result = `Appointment successfully confirmed. Details: Patient name: ${patientName}, Phone: ${patientPhone}, Reason: ${reason}, Date: ${date}, Time: ${formatTimeReadable(startAt)}. The appointment has been saved to the calendar. Please read these details back to the patient clearly and tell them they will receive a reminder before their appointment.`;

          } catch (err: any) {
            console.error('=== BOOKING FAILED ===');
            console.error('Error message:', err?.message);
            console.error('Error stack:', err?.stack);
            result = 'There was an issue booking the appointment. Please apologise to the patient and let them know a staff member will call them back shortly to confirm their booking.';
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