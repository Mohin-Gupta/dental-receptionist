import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { clearCallState } from '../tools/state';
import { requireMachineAuth } from '../auth/middleware';
import {
  checkAvailability,
  validateSlot,
  storeName,
  confirmDetails,
  findAppointment,
  cancelAppointment,
  rescheduleAppointment,
  bookAppointment,
} from '../tools';
import { extractDurationSecs, extractDirectionAndPhone } from '../lib/vapiPayloadHelpers';

const router = Router();

const TOOL_HANDLERS: Record<
  string,
  (clinicId: string, callId: string, params: any, callerNumber?: string) => Promise<string> | string
> = {
  checkAvailability:     (c, id, p) => checkAvailability(c, id, p),
  validateSlot:          (c, id, p) => validateSlot(c, id, p),
  storeName:             (_c, id, p) => storeName(id, p),
  confirmDetails:        (_c, id, p, callerNumber) => confirmDetails(id, p, callerNumber),
  findAppointment:       (c, _id, p) => findAppointment(c, p),
  cancelAppointment:     (c, _id, p) => cancelAppointment(c, p),
  rescheduleAppointment: (c, _id, p) => rescheduleAppointment(c, p),
  bookAppointment:       (c, id, p)  => bookAppointment(c, id, p),
};

router.post('/webhook/vapi', requireMachineAuth, async (req, res) => {
  const event = req.body;
  const type  = event?.message?.type;

  console.log('Vapi event:', type);

  try {
    if (type === 'tool-calls') {
      const toolCallList = event.message.toolCallList;
      const clinicId     = process.env.DEFAULT_CLINIC_ID!;
      const callId       = event.message.call?.id ?? 'unknown';
      const results      = [];

      const { phoneNumber: callerNumber } = extractDirectionAndPhone(event.message);

      for (const toolCall of toolCallList) {
        const name    = toolCall.function.name;
        const rawArgs = toolCall.function.arguments;
        const parameters = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs ?? {};

        console.log(`Tool: ${name}`, JSON.stringify(parameters, null, 2));

        let result = '';
        const handler = TOOL_HANDLERS[name];

        if (handler) {
          try {
            result = await handler(clinicId, callId, parameters, callerNumber ?? undefined);
          } catch (err: any) {
            console.error(`Tool ${name} failed:`, err?.message);
            result = 'Something went wrong. Please apologise and tell the patient a team member will call them back.';
          }
        } else {
          console.warn(`Unknown tool: ${name}`);
          result = 'I could not process that. Please apologise and offer to have someone call back.';
        }

        results.push({ toolCallId: toolCall.id, result });
      }

      return res.json({ results });
    }

    if (type === 'end-of-call-report') {
      const call       = event.message.call;
      const transcript = event.message.transcript ?? [];
      const clinicId   = process.env.DEFAULT_CLINIC_ID!;

      if (call?.id) clearCallState(call.id);

      const durationSecs = extractDurationSecs(event.message);
      const { direction, phoneNumber } = extractDirectionAndPhone(event.message);

      console.log('Extracted duration (secs):', durationSecs);
      console.log('Extracted direction:', direction, '— phone:', phoneNumber);

      let patientId: string | undefined;

      if (phoneNumber) {
        const cleanPhone = phoneNumber.replace(/\D/g, '').slice(-10);
        const patient = await prisma.patient.findFirst({
          where: { clinicId, phone: { endsWith: cleanPhone } },
        });
        if (patient) patientId = patient.id;
      }

      try {
        const saved = await prisma.callLog.create({
          data: {
            clinicId,
            vapiCallId:  call.id,
            patientId:   patientId ?? null,
            direction,
            phoneNumber: phoneNumber ?? null,
            durationSecs,
            transcript,
            outcome:     'completed',
          },
        });
        console.log('Call log saved ✓', saved.id, '—', direction, '—', phoneNumber, '—', durationSecs, 'secs');
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
