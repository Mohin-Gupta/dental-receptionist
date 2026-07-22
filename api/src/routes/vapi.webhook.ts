import crypto from 'crypto';
import { type Request } from 'express';
import { z } from 'zod';
import { encryptSecret } from '../auth/secretBox';
import { requireMachineAuth } from '../auth/middleware';
import { prisma } from '../lib/prisma';
import { phonesMatch, toE164 } from '../lib/phone';
import { extractDirectionAndPhone, extractDurationSecs } from '../lib/vapiPayloadHelpers';
import {
  markWebhookFailed,
  markWebhookProcessed,
  markWebhookProcessing,
  readWebhookResponse,
  receiveProviderWebhook,
} from '../services/providerWebhookInbox';
import {
  extractVapiCallId,
  extractVapiPhoneNumberId,
  resolveVapiTenant,
  VapiTenantResolutionError,
} from '../services/vapiTenant';
import { recordProviderCost, recordUsageEvent, USAGE_METRICS } from '../billing/usage';
import {
  assertCommercialFeatureAccess,
  COMMERCIAL_FEATURES,
  CommercialAccessError,
  reserveExistingCommunicationAttempt,
} from '../billing/access';
import { getVapiInboundReservationSeconds } from '../services/vapiOutbound';
import { clearCallState } from '../tools/state';
import {
  requestCallerVerification,
  verifyCallerCode,
} from '../tools/callerVerification';
import { createRouter } from '../lib/asyncRouter';
import { VAPI_TOOL_PARAMETER_SCHEMAS } from '../services/vapiToolSchemas';
import {
  bookAppointment,
  cancelAppointment,
  checkAvailability,
  confirmDetails,
  findAppointment,
  rescheduleAppointment,
  storeName,
  validateSlot,
} from '../tools';

const router = createRouter();

const toolCallSchema = z.object({
  id: z.string().trim().min(1).max(200),
  function: z.object({
    name: z.string().trim().min(1).max(100),
    arguments: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

const webhookSchema = z.object({
  message: z.object({
    type: z.string().trim().min(1).max(100),
    call: z.object({ id: z.string().trim().min(1).max(200) }).passthrough().optional(),
    toolCallList: z.array(toolCallSchema).min(1).max(20).optional(),
  }).passthrough(),
}).passthrough();

type ToolHandler = (
  clinicId: string,
  callId: string,
  parameters: any,
  callerNumber?: string
) => Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  checkAvailability: (clinicId, callId, parameters) =>
    checkAvailability(clinicId, callId, parameters),
  validateSlot: (clinicId, callId, parameters) =>
    validateSlot(clinicId, callId, parameters),
  storeName: (clinicId, callId, parameters) => storeName(clinicId, callId, parameters),
  confirmDetails: (clinicId, callId, parameters, callerNumber) =>
    confirmDetails(clinicId, callId, parameters, callerNumber),
  requestCallerVerification: (clinicId, callId, parameters, callerNumber) =>
    requestCallerVerification(clinicId, callId, parameters, callerNumber),
  verifyCallerCode: (clinicId, callId, parameters) =>
    verifyCallerCode(clinicId, callId, parameters),
  findAppointment: (clinicId, callId, parameters, callerNumber) =>
    findAppointment(clinicId, callId, parameters, callerNumber),
  cancelAppointment: (clinicId, callId, parameters, callerNumber) =>
    cancelAppointment(clinicId, callId, parameters, callerNumber),
  rescheduleAppointment: (clinicId, callId, parameters, callerNumber) =>
    rescheduleAppointment(clinicId, callId, parameters, callerNumber),
  bookAppointment: (clinicId, callId, parameters) =>
    bookAppointment(clinicId, callId, parameters),
};

function safeParseArguments(rawArguments: unknown): unknown {
  if (typeof rawArguments !== 'string') return rawArguments ?? {};
  if (Buffer.byteLength(rawArguments, 'utf8') > 16 * 1024) {
    throw new Error('Tool arguments exceed the allowed size');
  }
  return JSON.parse(rawArguments);
}

function bodyDigest(req: Request): string {
  const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body), 'utf8');
  return crypto.createHash('sha256').update(body).digest('hex');
}

function webhookIdempotencyKey(req: Request, message: any): string {
  const callId = extractVapiCallId(message) ?? 'missing-call-id';
  if (message.type === 'tool-calls' && Array.isArray(message.toolCallList)) {
    const ids = message.toolCallList
      .map((toolCall: any) => String(toolCall?.id ?? ''))
      .filter(Boolean)
      .sort();
    if (ids.length > 0) return `${callId}:tool-calls:${ids.join(',')}`;
  }
  if (message.type === 'assistant-request') return `${callId}:assistant-request`;
  if (message.type === 'end-of-call-report') return `${callId}:end-of-call-report`;
  return `${callId}:${String(message.type)}:${bodyDigest(req).slice(0, 32)}`;
}

function auditHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'user-agent', 'x-vapi-timestamp']) {
    const value = req.header(name);
    if (value) headers[name] = value.slice(0, 500);
  }
  return headers;
}

function auditPayload(req: Request, message: any) {
  const toolCalls = Array.isArray(message?.toolCallList)
    ? message.toolCallList.slice(0, 20).map((toolCall: any) => ({
        id: typeof toolCall?.id === 'string' ? toolCall.id.slice(0, 200) : null,
        name: typeof toolCall?.function?.name === 'string'
          ? toolCall.function.name.slice(0, 100)
          : null,
      }))
    : [];
  return {
    schemaVersion: 1,
    eventType: String(message?.type ?? 'unknown').slice(0, 100),
    callId: extractVapiCallId(message),
    phoneNumberId: extractVapiPhoneNumberId(message),
    bodySha256: bodyDigest(req),
    rawBodyBytes: req.rawBody?.byteLength ?? null,
    toolCalls,
    // Arguments, customer numbers, transcripts, summaries and recordings are
    // deliberately excluded. Request-time processing still uses the verified
    // body; the durable inbox is an audit/idempotency record, not PHI storage.
  };
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractVapiCostUsd(message: any): number | null {
  const breakdown = [message?.costBreakdown, message?.call?.costBreakdown]
    .find(value => value && typeof value === 'object' && !Array.isArray(value));
  const values = [
    message?.cost,
    message?.call?.cost,
    breakdown?.total,
  ];
  const cost = values.find(value => typeof value === 'number' && Number.isFinite(value));
  if (typeof cost === 'number' && cost >= 0) return cost;

  const costs = Array.isArray(message?.costs)
    ? message.costs
    : Array.isArray(message?.call?.costs) ? message.call.costs : [];
  const components = costs.map((entry: any) => entry?.cost);
  return components.length > 0 && components.every(
    (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  )
    ? components.reduce((sum: number, value: number) => sum + value, 0)
    : null;
}

function extractVapiMeteredUsage(message: any) {
  const breakdown = [message?.costBreakdown, message?.call?.costBreakdown]
    .find(value => value && typeof value === 'object' && !Array.isArray(value));
  if (!breakdown) return [] as Array<{ metric: string; quantity: number; unit: string }>;

  const fields = [
    [USAGE_METRICS.VAPI_LLM_PROMPT_TOKENS, breakdown.llmPromptTokens, 'token'],
    [USAGE_METRICS.VAPI_LLM_CACHED_PROMPT_TOKENS, breakdown.llmCachedPromptTokens, 'token'],
    [USAGE_METRICS.VAPI_LLM_COMPLETION_TOKENS, breakdown.llmCompletionTokens, 'token'],
    [USAGE_METRICS.VAPI_TTS_CHARACTERS, breakdown.ttsCharacters, 'character'],
  ] as const;
  return fields.flatMap(([metric, value, unit]) => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? [{ metric, quantity: value, unit }]
      : []
  ));
}

async function findPatientForCaller(
  organizationId: string,
  callerNumber: string | null,
  defaultCallingCode: string
): Promise<string | null> {
  if (!callerNumber) return null;

  let normalized: string;
  try {
    normalized = toE164(callerNumber, defaultCallingCode);
  } catch {
    return null;
  }

  // Legacy rows can be national-format numbers. Narrow by national suffix,
  // then require an exact E.164 comparison in application code.
  const candidates = await prisma.patient.findMany({
    where: {
      organizationId,
      phone: { endsWith: normalized.replace(/\D/g, '').slice(-10) },
    },
    select: { id: true, phone: true },
    take: 20,
  });
  return candidates.find(candidate =>
    phonesMatch(candidate.phone, normalized, defaultCallingCode)
  )?.id ?? null;
}

async function processToolCalls(message: any, tenant: Awaited<ReturnType<typeof resolveVapiTenant>>) {
  const parsedToolCalls = z.array(toolCallSchema).min(1).max(20).parse(message.toolCallList);
  const { phoneNumber: callerNumber } = extractDirectionAndPhone(message);
  const results: Array<{ toolCallId: string; result: string }> = [];

  for (const toolCall of parsedToolCalls) {
    const name = toolCall.function.name;
    const handler = TOOL_HANDLERS[name];
    const parameterSchema = VAPI_TOOL_PARAMETER_SCHEMAS[name];
    let result: string;

    if (!handler || !parameterSchema) {
      result = 'I could not process that request. Apologise and offer to have clinic staff call back.';
    } else {
      try {
        const rawParameters = safeParseArguments(toolCall.function.arguments);
        const parameters = parameterSchema.parse(rawParameters);
        result = await handler(
          tenant.clinicId,
          tenant.callId,
          parameters,
          callerNumber ?? undefined
        );
      } catch (error) {
        const invalidInput = error instanceof z.ZodError || error instanceof SyntaxError;
        if (!invalidInput) {
          console.error('Vapi tool execution failed', { tool: name, callId: tenant.callId });
        }
        result = invalidInput
          ? 'The request details were incomplete or invalid. Ask the patient to repeat the required details.'
          : 'Something went wrong. Apologise and tell the patient a team member will call them back.';
      }
    }

    results.push({ toolCallId: toolCall.id, result });
  }

  return { results };
}

function accessDeniedToolResponse(message: any) {
  const toolCalls = z.array(toolCallSchema).min(1).max(20).parse(message.toolCallList);
  return {
    results: toolCalls.map(toolCall => ({
      toolCallId: toolCall.id,
      result: 'This clinic service is temporarily unavailable. Apologise, do not perform the requested action, and end the call.',
    })),
  };
}

async function reserveInboundCommercialAccess(
  tenant: Awaited<ReturnType<typeof resolveVapiTenant>>
): Promise<boolean> {
  if (
    tenant.resource.status !== 'active' ||
    !['active', 'past_due_grace'].includes(tenant.organizationStatus) ||
    (tenant.attempt.direction === 'inbound' && !tenant.inboundAssistantId)
  ) return false;
  try {
    // Check non-consumptive feature access before reserving voice spend so a
    // denied appointment entitlement cannot strand a reservation for a call
    // that Vapi never starts.
    await assertCommercialFeatureAccess({
      organizationId: tenant.organizationId,
      clinicId: tenant.clinicId,
      feature: COMMERCIAL_FEATURES.APPOINTMENTS,
    });
    await reserveExistingCommunicationAttempt({
      attemptId: tenant.attempt.id,
      organizationId: tenant.organizationId,
      clinicId: tenant.clinicId,
      feature: COMMERCIAL_FEATURES.VOICE,
      metric: USAGE_METRICS.VOICE_SECONDS,
      estimatedQuantity: getVapiInboundReservationSeconds(),
      unit: 'second',
    });
    return true;
  } catch (error) {
    if (error instanceof CommercialAccessError) return false;
    throw error;
  }
}

async function processEndOfCall(message: any, tenant: Awaited<ReturnType<typeof resolveVapiTenant>>) {
  const durationSeconds = extractDurationSecs(message);
  const { direction, phoneNumber } = extractDirectionAndPhone(message);
  const patientId = await findPatientForCaller(
    tenant.organizationId,
    phoneNumber,
    tenant.defaultCallingCode
  );
  const endedAt = dateOrNull(message?.endedAt ?? message?.call?.endedAt) ?? new Date();
  const startedAt = dateOrNull(message?.startedAt ?? message?.call?.startedAt);

  const consentGranted = Boolean(message?.compliance?.recordingConsent?.grantedAt);
  const transcriptSource = message?.artifact?.transcript ?? message?.transcript ?? null;
  const storeTranscript = process.env.VAPI_STORE_TRANSCRIPTS === 'true' && consentGranted;
  const transcript = storeTranscript && transcriptSource !== null
    ? {
        protected: 'secret-box-v1',
        ciphertext: encryptSecret(
          JSON.stringify(transcriptSource),
          `call-log:${tenant.organizationId}:${tenant.callId}:transcript`
        ),
      }
    : {
        retained: false,
        reason: consentGranted ? 'transcript_storage_disabled' : 'recording_consent_not_recorded',
      };

  const callLog = await prisma.callLog.upsert({
    where: { vapiCallId: tenant.callId },
    create: {
      organizationId: tenant.organizationId,
      clinicId: tenant.clinicId,
      patientId,
      vapiCallId: tenant.callId,
      direction,
      phoneNumber,
      durationSecs: durationSeconds,
      transcript,
      outcome: 'completed',
    },
    update: {
      patientId,
      direction,
      phoneNumber,
      durationSecs: durationSeconds,
      transcript,
      outcome: 'completed',
    },
  });

  await prisma.communicationAttempt.update({
    where: { id: tenant.attempt.id },
    data: {
      callLogId: callLog.id,
      patientId,
      status: 'completed',
      durationSeconds,
      startedAt: startedAt ?? tenant.attempt.startedAt,
      endedAt,
      response: {
        endedReason: String(message?.endedReason ?? message?.call?.endedReason ?? 'unknown'),
        recordingConsent: consentGranted,
      },
    },
  });

  let usageEvent: Awaited<ReturnType<typeof recordUsageEvent>> | null = null;
  if (durationSeconds && durationSeconds > 0) {
    usageEvent = await recordUsageEvent({
      organizationId: tenant.organizationId,
      clinicId: tenant.clinicId,
      providerResourceId: tenant.resource.id,
      communicationAttemptId: tenant.attempt.id,
      metric: USAGE_METRICS.VOICE_SECONDS,
      quantity: durationSeconds,
      unit: 'second',
      source: 'vapi_end_of_call_report',
      externalEventId: tenant.callId,
      idempotencyKey: `vapi:${tenant.callId}:voice-seconds`,
      occurredAt: endedAt,
      metadata: { direction },
    });
  }

  for (const metered of extractVapiMeteredUsage(message)) {
    await recordUsageEvent({
      organizationId: tenant.organizationId,
      clinicId: tenant.clinicId,
      providerResourceId: tenant.resource.id,
      communicationAttemptId: tenant.attempt.id,
      metric: metered.metric,
      quantity: metered.quantity,
      unit: metered.unit,
      source: 'vapi_end_of_call_report',
      externalEventId: tenant.callId,
      idempotencyKey: `vapi:${tenant.callId}:${metered.metric}`,
      occurredAt: endedAt,
      metadata: { direction },
    });
  }

  const costUsd = extractVapiCostUsd(message);
  if (costUsd !== null) {
    await recordProviderCost({
      organizationId: tenant.organizationId,
      clinicId: tenant.clinicId,
      providerResourceId: tenant.resource.id,
      communicationAttemptId: tenant.attempt.id,
      usageEventId: usageEvent?.id ?? null,
      provider: 'vapi',
      costType: 'voice_call',
      quantity: durationSeconds ?? undefined,
      unit: durationSeconds ? 'second' : undefined,
      amountMicros: BigInt(Math.round(costUsd * 1_000_000)),
      currency: 'USD',
      externalEventId: tenant.callId,
      idempotencyKey: `${tenant.callId}:reported-cost`,
      occurredAt: endedAt,
    });
  }

  // The terminal report closes this retail event stream. Any missing provider
  // duration/cost is reconciled later without holding back token usage already
  // recorded above or coupling the customer ledger to vendor cost.
  await prisma.communicationAttempt.update({
    where: { id: tenant.attempt.id },
    data: { usageFinalizedAt: new Date() },
  });

  await clearCallState(tenant.clinicId, tenant.callId);
  return { received: true };
}

router.post('/webhook/vapi', requireMachineAuth, async (req, res) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  const message = parsed.data.message;
  if (message.type === 'tool-calls' && !message.toolCallList) {
    return res.status(400).json({ error: 'Tool calls are missing' });
  }

  const idempotencyKey = webhookIdempotencyKey(req, message);
  const received = await receiveProviderWebhook({
    provider: 'vapi',
    idempotencyKey,
    externalEventId: typeof (req.body as any)?.id === 'string' ? (req.body as any).id : null,
    eventType: message.type,
    signatureValid: req.machineAuth?.method === 'hmac',
    payload: auditPayload(req, message),
    headers: auditHeaders(req),
  });

  if (received.event.status === 'processed') {
    const storedResponse = readWebhookResponse(received.event);
    return res.json(storedResponse ?? { received: true, duplicate: true });
  }

  let tenant: Awaited<ReturnType<typeof resolveVapiTenant>>;
  try {
    tenant = await resolveVapiTenant(message, {
      allowInactiveForTerminalAccounting: message.type === 'end-of-call-report',
    });
  } catch (error) {
    await markWebhookFailed(received.event.id, error, 'quarantined');
    const code = error instanceof VapiTenantResolutionError ? error.code : 'tenant_resolution_failed';
    console.error('Vapi webhook quarantined', { eventId: received.event.id, code });
    return res.status(503).json({ error: 'Provider resource mapping unavailable' });
  }

  const claimed = await markWebhookProcessing(received.event.id, {
    organizationId: tenant.organizationId,
    providerResourceId: tenant.resource.id,
    communicationAttemptId: tenant.attempt.id,
  });
  if (!claimed) {
    return ['assistant-request', 'tool-calls'].includes(message.type)
      ? res.status(503).json({ error: 'Webhook is already processing' })
      : res.status(202).json({ received: true, processing: true });
  }

  try {
    let response: unknown;
    if (message.type === 'assistant-request') {
      const explicitlyInbound = message?.call?.type === 'inboundPhoneCall';
      const admitted = explicitlyInbound && await reserveInboundCommercialAccess(tenant);
      if (!admitted) {
        await prisma.communicationAttempt.update({
          where: { id: tenant.attempt.id },
          data: {
            status: 'failed',
            errorCode: explicitlyInbound ? 'commercial_admission_denied' : 'invalid_call_direction',
            errorMessage: 'The call was rejected before assistant assignment',
            endedAt: new Date(),
            usageFinalizedAt: new Date(),
          },
        });
      }
      response = admitted && tenant.inboundAssistantId
        ? { assistantId: tenant.inboundAssistantId }
        : { error: 'This clinic service is temporarily unavailable. Please call the clinic again later.' };
    } else if (message.type === 'tool-calls') {
      const admitted = await reserveInboundCommercialAccess(tenant);
      response = !admitted
        ? accessDeniedToolResponse(message)
        : await processToolCalls(message, tenant);
    } else if (message.type === 'end-of-call-report') {
      response = await processEndOfCall(message, tenant);
    } else {
      response = { received: true };
    }

    await markWebhookProcessed(received.event, response);
    return res.json(response);
  } catch (error) {
    await markWebhookFailed(received.event.id, error);
    console.error('Vapi webhook processing failed', {
      eventId: received.event.id,
      callId: tenant.callId,
      eventType: message.type,
    });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
