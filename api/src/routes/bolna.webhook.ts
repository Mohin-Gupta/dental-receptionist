/**
 * Bolna-facing webhook routes, built side by side with vapi.webhook.ts (which
 * is untouched by this file). Structurally different from Vapi's webhook in
 * two important ways, both driven by how Bolna's API actually works (see
 * bolnaAgentBlueprint.ts and bolnaClient.ts for the sourcing):
 *
 *  1. Bolna dispatches each custom-function tool call directly to that
 *     tool's own configured URL, as a plain JSON body with no envelope or
 *     toolCallId — not a single generic "tool-calls" message covering a
 *     batch, the way Vapi's webhook works. `/tools/:toolName` below is a
 *     single generic dispatcher keyed by the URL path segment.
 *
 *  2. Bolna's inbound routing is static (bound once via
 *     platformBolnaProvisioningCli.ts's call to POST /inbound/setup), so
 *     there is no assistant-request-equivalent pre-connection gating
 *     webhook the way Vapi has. This means a fully commercially-blocked
 *     tenant's Bolna calls will still ring and cost Bolna/Vobiz minutes even
 *     though every tool call below will decline to help — commercial access
 *     is enforced per-tool-call here (the earliest point Bolna gives us),
 *     not pre-connection. Worth knowing since it changes the risk profile
 *     slightly versus Vapi, which can hard-reject before the call connects.
 *
 * Human handoff (transferToHuman) deliberately bypasses Bolna's own built-in
 * Transfer Call tool entirely and drives the live transfer through Vobiz's
 * Transfer API directly — see the comment on handleTransferToHuman below and
 * vobizClient.ts for why, and what remains unverified about it.
 */
import { z } from 'zod';
import { requireBolnaMachineAuth } from '../auth/middleware';
import { decryptSecret, encryptSecret } from '../auth/secretBox';
import {
  COMMERCIAL_FEATURES,
  CommercialAccessError,
  assertCommercialFeatureAccess,
  reserveExistingCommunicationAttempt,
} from '../billing/access';
import { USAGE_METRICS, recordUsageEvent, recordProviderCost } from '../billing/usage';
import { createRouter } from '../lib/asyncRouter';
import { toE164 } from '../lib/phone';
import { prisma } from '../lib/prisma';
import {
  markWebhookFailed,
  markWebhookProcessed,
  markWebhookProcessing,
  readWebhookResponse,
  receiveProviderWebhook,
} from '../services/providerWebhookInbox';
import { getBolnaInboundReservationSeconds } from '../services/bolnaOutbound';
import { BolnaTenantResolutionError, resolveBolnaTenant, type ResolvedBolnaTenant } from '../services/bolnaTenant';
import { transferVobizCall, vobizDialInstructionXml, vobizHangupInstructionXml } from '../services/vobizClient';
import {
  bookAppointment,
  cancelAppointment,
  checkAvailability,
  confirmDetails,
  findAppointment,
  findDoctors,
  rescheduleAppointment,
  storeName,
  validateSlot,
} from '../tools';
import { requestCallerVerification, verifyCallerCode } from '../tools/callerVerification';
import { fail, ok, type ToolResponse } from '../tools/toolResponse';
import { VAPI_TOOL_PARAMETER_SCHEMAS as TOOL_PARAMETER_SCHEMAS } from '../services/vapiToolSchemas';

const router = createRouter();

type ToolHandler = (
  clinicId: string,
  callId: string,
  parameters: unknown,
  callerNumber?: string
) => Promise<ToolResponse>;

// Same business logic Vapi already uses, from ../tools — duplicated here as
// a small dispatch table (rather than importing vapi.webhook.ts's private
// one) so nothing about Vapi's file needs to change for this to exist.
const BUSINESS_TOOL_HANDLERS: Record<string, ToolHandler> = {
  checkAvailability: (clinicId, callId, parameters) => checkAvailability(clinicId, callId, parameters as never),
  findDoctors: (clinicId, callId, parameters) => findDoctors(clinicId, callId, parameters as never),
  validateSlot: (clinicId, callId, parameters) => validateSlot(clinicId, callId, parameters as never),
  storeName: (clinicId, callId, parameters) => storeName(clinicId, callId, parameters as never),
  confirmDetails: (clinicId, callId, parameters, callerNumber) =>
    confirmDetails(clinicId, callId, parameters as never, callerNumber),
  requestCallerVerification: (clinicId, callId, parameters, callerNumber) =>
    requestCallerVerification(clinicId, callId, parameters, callerNumber),
  verifyCallerCode: (clinicId, callId, parameters) => verifyCallerCode(clinicId, callId, parameters),
  findAppointment: (clinicId, callId, parameters, callerNumber) =>
    findAppointment(clinicId, callId, parameters, callerNumber),
  cancelAppointment: (clinicId, callId, parameters, callerNumber) =>
    cancelAppointment(clinicId, callId, parameters, callerNumber),
  rescheduleAppointment: (clinicId, callId, parameters, callerNumber) =>
    rescheduleAppointment(clinicId, callId, parameters, callerNumber),
  bookAppointment: (clinicId, callId, parameters) => bookAppointment(clinicId, callId, parameters as never),
};

const SYSTEM_CONTEXT_KEYS = ['to_number', 'call_sid', 'from_number', 'agent_id'] as const;

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripSystemContext(body: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...body };
  for (const key of SYSTEM_CONTEXT_KEYS) delete clone[key];
  return clone;
}

/**
 * Bolna's %(field)s tool-param templating always sends every declared
 * parameter, filling in an empty string when the LLM had nothing to supply
 * for an optional field on this turn — unlike Vapi's function-calling,
 * which simply omits the key. The shared Zod schemas in vapiToolSchemas.ts
 * mark those fields `.optional()` meaning "key may be absent", not "value
 * may be empty", so an empty string still fails e.g. `.min(1)`. Dropping
 * empty-string keys here (Bolna-only, so Vapi's parsing is untouched)
 * before validation makes "nothing supplied" behave the same way for both
 * providers. A still-required field (e.g. date) left empty this way
 * correctly still fails validation — just as "missing", which is accurate.
 */
export function dropBolnaEmptyStrings(body: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === '') continue;
    clone[key] = value;
  }
  return clone;
}

const APOLOGY_SAY =
  'This clinic service is temporarily unavailable. Apologise to the patient in their current language, do not perform the requested action, and offer a clinic staff callback.';

/**
 * Bolna's Transfer Call tool has a single static destination number
 * configured at agent-setup time and cannot be pointed at a different
 * number per call (there is no documented mechanism — including the
 * pre-call webhook, which is fire-and-forget notification only — for a
 * server response to override it dynamically). Since every clinic needs its
 * own handoff number, this tool bypasses Bolna's transfer mechanism
 * entirely: it resolves the destination the same way every other tool here
 * resolves its clinic, then drives the actual live transfer through Vobiz's
 * Transfer API directly, independent of Bolna.
 */
async function handleTransferToHuman(
  tenant: ResolvedBolnaTenant,
  ownVobizNumber: string
): Promise<ToolResponse> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: tenant.clinicId },
    select: { handoffPhoneNumber: true },
  });
  if (!clinic?.handoffPhoneNumber) {
    return fail(
      'NO_HANDOFF_NUMBER',
      'No human handoff number is configured for this clinic. Apologise to the patient in their current language and offer to take a message instead.'
    );
  }

  let handoffNumber: string;
  try {
    handoffNumber = toE164(clinic.handoffPhoneNumber, tenant.defaultCallingCode);
  } catch {
    console.error('Invalid clinic handoff number', { clinicId: tenant.clinicId, callId: tenant.callId });
    return fail(
      'INVALID_HANDOFF_NUMBER',
      'The configured human handoff number is invalid. Apologise to the patient in their current language and offer to take a message instead.'
    );
  }

  try {
    await transferVobizCall({
      callUuid: tenant.callId,
      destinationUrl: buildVobizTransferXmlUrl(tenant.clinicId, ownVobizNumber),
    });
  } catch (error) {
    // Bolna's call_sid has been confirmed to equal the Vobiz call_uuid (see
    // vobizClient.ts) for calls routed through Vobiz. This still fails
    // closed on any Vobiz-side error rather than transferring blind.
    console.error('Vobiz transfer failed', {
      clinicId: tenant.clinicId,
      callId: tenant.callId,
      message: error instanceof Error ? error.message : String(error),
    });
    return fail(
      'TRANSFER_UNAVAILABLE',
      'Human handoff is temporarily unavailable. Apologise to the patient in their current language and offer to take a message instead.'
    );
  }

  return ok(
    'TRANSFERRING',
    'The call is being transferred now. Tell the patient briefly, in their current language, that you are connecting them to the clinic team, then stop talking — do not continue the conversation after this.'
  );
}

const VOBIZ_TRANSFER_XML_PURPOSE = 'vobiz-transfer-xml';
const VOBIZ_TRANSFER_TOKEN_TTL_MS = 3 * 60 * 1000;

function buildVobizTransferXmlUrl(clinicId: string, ownVobizNumber: string): string {
  const token = encryptSecret(
    JSON.stringify({ clinicId, ownVobizNumber, exp: Date.now() + VOBIZ_TRANSFER_TOKEN_TTL_MS }),
    VOBIZ_TRANSFER_XML_PURPOSE
  );
  const base = process.env.PUBLIC_API_URL ?? 'http://localhost:3001';
  const url = new URL('/api/webhook/vobiz/transfer-xml', base);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Fetched by Vobiz itself (not Bolna) once transferVobizCall's request is
 * accepted, so this is intentionally not behind requireBolnaMachineAuth —
 * Vobiz will not have that bearer token. Protected instead by a short-lived,
 * opaque, encrypted token so the URL can't be guessed or reused.
 */
router.get('/webhook/vobiz/transfer-xml', async (req, res) => {
  res.type('application/xml');
  const token = typeof req.query.token === 'string' ? req.query.token : null;
  if (!token) return res.status(400).send(vobizHangupInstructionXml());

  let clinicId: string;
  let ownVobizNumber: string;
  try {
    const decoded = JSON.parse(decryptSecret(token, VOBIZ_TRANSFER_XML_PURPOSE)) as {
      clinicId?: unknown;
      ownVobizNumber?: unknown;
      exp?: unknown;
    };
    if (
      typeof decoded.clinicId !== 'string' ||
      typeof decoded.ownVobizNumber !== 'string' ||
      typeof decoded.exp !== 'number' ||
      decoded.exp < Date.now()
    ) {
      throw new Error('expired or malformed transfer token');
    }
    clinicId = decoded.clinicId;
    ownVobizNumber = decoded.ownVobizNumber;
  } catch {
    return res.status(403).send(vobizHangupInstructionXml());
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { handoffPhoneNumber: true, defaultCallingCode: true },
  });
  if (!clinic?.handoffPhoneNumber) return res.status(404).send(vobizHangupInstructionXml());

  try {
    return res.send(
      vobizDialInstructionXml(toE164(clinic.handoffPhoneNumber, clinic.defaultCallingCode), ownVobizNumber)
    );
  } catch {
    return res.status(500).send(vobizHangupInstructionXml());
  }
});

router.post('/webhook/bolna/tools/:toolName', requireBolnaMachineAuth, async (req, res) => {
  const toolName = req.params.toolName;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const toNumber = stringField(body, 'to_number');
  const callSid = stringField(body, 'call_sid');
  const fromNumber = stringField(body, 'from_number') ?? undefined;

  if (!callSid) {
    return res.status(400).json(fail('INVALID_REQUEST', 'call_sid is required'));
  }

  let tenant: ResolvedBolnaTenant;
  try {
    tenant = await resolveBolnaTenant({ callId: callSid, toNumber, fromNumber });
  } catch (error) {
    if (!(error instanceof BolnaTenantResolutionError)) throw error;
    console.error('Bolna tool webhook tenant resolution failed', {
      toolName,
      callSid,
      code: error.code,
    });
    // 200, not 4xx/5xx: Bolna feeds this body straight back to the LLM as
    // the function's *result*, not treated as a transport-level failure — an
    // HTTP error status here would surface to Bolna as a broken tool call,
    // not a speakable apology to the caller.
    return res.status(200).json(fail('SERVICE_UNAVAILABLE', APOLOGY_SAY));
  }

  if (toolName === 'transferToHuman') {
    if (!toNumber) {
      return res.status(200).json(fail('SERVICE_UNAVAILABLE', APOLOGY_SAY));
    }
    return res.json(await handleTransferToHuman(tenant, toNumber));
  }

  const handler = BUSINESS_TOOL_HANDLERS[toolName];
  const parameterSchema = TOOL_PARAMETER_SCHEMAS[toolName];
  if (!handler || !parameterSchema) {
    return res.status(200).json(fail('UNKNOWN_TOOL', APOLOGY_SAY));
  }

  // Bolna has no pre-connection gating webhook the way Vapi's
  // assistant-request works (see file header) — this is the earliest point
  // available to enforce commercial access and reserve voice usage.
  try {
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
      estimatedQuantity: getBolnaInboundReservationSeconds(),
      unit: 'second',
    });
  } catch (error) {
    if (error instanceof CommercialAccessError) {
      return res.status(200).json(fail('SERVICE_UNAVAILABLE', APOLOGY_SAY));
    }
    throw error;
  }

  let response: ToolResponse;
  try {
    const parameters = parameterSchema.parse(dropBolnaEmptyStrings(stripSystemContext(body)));
    response = await handler(tenant.clinicId, tenant.callId, parameters, fromNumber);
  } catch (error) {
    if (error instanceof z.ZodError) {
      response = fail(
        'INVALID_REQUEST',
        'The request details were incomplete or invalid. Ask the patient, in their current language, to repeat the required details.'
      );
    } else {
      console.error('Bolna tool execution failed', {
        tool: toolName,
        callId: tenant.callId,
        message: error instanceof Error ? error.message : String(error),
      });
      response = fail(
        'INTERNAL_ERROR',
        'Something went wrong on our side. Apologise to the patient in their current language and tell them a team member will call back.'
      );
    }
  }

  return res.status(200).json(response);
});

// Confirmed against Bolna's GET /executions/{execution_id} response shape
// (id, conversation_time, total_cost, telephony_data.duration) — this
// product's execution webhook payload mirrors that same shape (see the
// module header). Exported so the field-guessing logic below is covered by
// tests/bolna-tools.test.ts independent of a live webhook call.
export function extractBolnaCallId(payload: Record<string, unknown>): string | null {
  return (
    stringField(payload, 'id') ??
    stringField(payload, 'call_id') ??
    stringField(payload, 'execution_id')
  );
}

export function extractBolnaDurationSecs(payload: Record<string, unknown>): number | null {
  const candidates = [payload.conversation_time, payload.conversation_duration, payload.duration, payload.call_duration];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.round(candidate);
    }
  }
  const telephony = payload.telephony_data;
  if (telephony && typeof telephony === 'object' && !Array.isArray(telephony)) {
    const duration = (telephony as Record<string, unknown>).duration;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) return Math.round(duration);
  }
  return null;
}

export function extractBolnaCostUsd(payload: Record<string, unknown>): number | null {
  const candidates = [payload.total_cost, payload.cost, payload.conversation_cost];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

export const TERMINAL_BOLNA_STATUSES = new Set(['completed', 'error', 'busy', 'no-answer', 'failed']);

router.post('/webhook/bolna/execution', requireBolnaMachineAuth, async (req, res) => {
  const payload = (req.body ?? {}) as Record<string, unknown>;
  const callId = extractBolnaCallId(payload);
  if (!callId) return res.status(400).json({ error: 'Missing execution/call id' });

  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  const idempotencyKey = `bolna:${callId}:execution:${status}`;

  const received = await receiveProviderWebhook({
    provider: 'bolna',
    idempotencyKey,
    externalEventId: callId,
    eventType: status,
    signatureValid: req.machineAuth?.method === 'bearer',
    payload: { schemaVersion: 1, callId, status },
    headers: {},
  });

  if (received.event.status === 'processed') {
    return res.json(readWebhookResponse(received.event) ?? { received: true });
  }

  if (!TERMINAL_BOLNA_STATUSES.has(status)) {
    // Non-terminal progress ping (queued/in-progress/etc.) — acknowledge
    // without finalizing billing/CallLog yet.
    await markWebhookProcessed(received.event, { received: true });
    return res.json({ received: true });
  }

  let tenant: ResolvedBolnaTenant;
  try {
    tenant = await resolveBolnaTenant({
      callId,
      toNumber: stringField(payload, 'to_number'),
      options: { allowInactiveForTerminalAccounting: true },
    });
  } catch (error) {
    await markWebhookFailed(received.event.id, error, 'quarantined');
    console.error('Bolna execution webhook quarantined', {
      eventId: received.event.id,
      code: error instanceof BolnaTenantResolutionError ? error.code : 'unknown',
    });
    return res.status(503).json({ error: 'Provider resource mapping unavailable' });
  }

  const claimed = await markWebhookProcessing(received.event.id, {
    organizationId: tenant.organizationId,
    providerResourceId: tenant.resource.id,
    communicationAttemptId: tenant.attempt.id,
  });
  if (!claimed) return res.status(202).json({ received: true, processing: true });

  try {
    const durationSeconds = extractBolnaDurationSecs(payload);
    const endedAt = new Date();
    const outcome = status === 'completed' ? 'completed' : status;

    const callLog = await prisma.callLog.upsert({
      where: { providerCallId: callId },
      create: {
        organizationId: tenant.organizationId,
        clinicId: tenant.clinicId,
        vapiCallId: `bolna:${callId}`, // vapiCallId is unique+required; kept distinct from any real Vapi call id
        providerCallId: callId,
        direction: tenant.attempt.direction,
        phoneNumber: tenant.attempt.direction === 'outbound' ? tenant.attempt.destination : tenant.attempt.origin,
        durationSecs: durationSeconds,
        transcript: { retained: false, reason: 'bolna_transcript_storage_not_yet_implemented' },
        outcome,
      },
      update: { durationSecs: durationSeconds, outcome },
    });

    await prisma.communicationAttempt.update({
      where: { id: tenant.attempt.id },
      data: {
        callLogId: callLog.id,
        status: status === 'completed' ? 'completed' : 'failed',
        durationSeconds,
        endedAt,
        response: { status },
      },
    });

    if (durationSeconds && durationSeconds > 0) {
      await recordUsageEvent({
        organizationId: tenant.organizationId,
        clinicId: tenant.clinicId,
        providerResourceId: tenant.resource.id,
        communicationAttemptId: tenant.attempt.id,
        metric: USAGE_METRICS.VOICE_SECONDS,
        quantity: durationSeconds,
        unit: 'second',
        source: 'bolna_execution_webhook',
        externalEventId: callId,
        idempotencyKey: `bolna:${callId}:voice-seconds`,
        occurredAt: endedAt,
        metadata: { direction: tenant.attempt.direction },
      });
    }

    const costUsd = extractBolnaCostUsd(payload);
    if (costUsd !== null) {
      await recordProviderCost({
        organizationId: tenant.organizationId,
        clinicId: tenant.clinicId,
        providerResourceId: tenant.resource.id,
        communicationAttemptId: tenant.attempt.id,
        provider: 'bolna',
        costType: 'voice_call',
        quantity: durationSeconds ?? undefined,
        unit: durationSeconds ? 'second' : undefined,
        amountMicros: BigInt(Math.round(costUsd * 1_000_000)),
        currency: 'USD',
        externalEventId: callId,
        idempotencyKey: `${callId}:reported-cost`,
        occurredAt: endedAt,
      });
    }

    await prisma.communicationAttempt.update({
      where: { id: tenant.attempt.id },
      data: { usageFinalizedAt: new Date() },
    });

    const response = { received: true };
    await markWebhookProcessed(received.event, response);
    return res.json(response);
  } catch (error) {
    await markWebhookFailed(received.event.id, error);
    console.error('Bolna execution webhook processing failed', {
      eventId: received.event.id,
      callId,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
