import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { clearCallState } from '../tools/state';
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

const router = Router();

const TOOL_HANDLERS: Record<string, (clinicId: string, callId: string, params: any) => Promise<string>> = {
  checkAvailability: (c, id, p) => checkAvailability(c, id, p),
  validateSlot: (c, id, p) => validateSlot(c, id, p),
  storeName: (_c, id, p) => Promise.resolve(storeName(id, p)),
  confirmDetails: (_c, id, p) => Promise.resolve(confirmDetails(id, p)),
  findAppointment: (c, _id, p) => findAppointment(c, p),
  cancelAppointment: (c, _id, p) => cancelAppointment(c, p),
  rescheduleAppointment: (c, _id, p) => rescheduleAppointment(c, p),
  bookAppointment: (c, id, p) => bookAppointment(c, id, p),
};

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

        console.log(`Tool: ${name}`, JSON.stringify(parameters, null, 2));

        let result = '';

        const handler = TOOL_HANDLERS[name];
        if (handler) {
          try {
            result = await handler(clinicId, callId, parameters);
          } catch (err: any) {
            console.error(`Tool ${name} failed:`, err?.message);
            result = 'Something went wrong. Please apologise and tell the patient a team member will call them back.';
          }
        } else {
          console.warn(`Unknown tool: ${name}`);
          result = 'I could not process that request. Please apologise and offer to have someone call back.';
        }

        results.push({ toolCallId: toolCall.id, result });
      }

      return res.json({ results });
    }

    if (type === 'end-of-call-report') {
      const call = event.message.call;
      const transcript = event.message.transcript ?? [];

      if (call?.id) clearCallState(call.id);

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