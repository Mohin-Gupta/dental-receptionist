/**
 * Places a tenant-attributed, idempotent outbound call through Bolna.
 * Mirrors vapiOutbound.ts's placeOutboundCall contract closely, simplified
 * where Bolna's API allows it (no dynamic per-call assistant override the
 * way Vapi's outbound API supports — a Bolna phone number is bound to one
 * agent already, so outbound calls from that number always use that agent).
 *
 * Wired in: sixtyMinReminderJob.ts now calls placeBolnaOutboundCall directly
 * for the voice-reminder leg (feedbackSmsJob.ts and dailyAgendaJob.ts remain
 * SMS-only and never called vapiOutbound.ts, so nothing there needed to
 * change). vapiOutbound.ts itself is left untouched and still exists for
 * rollback / comparison during the Bolna cutover.
 */
import { Prisma } from '@prisma/client';
import { COMMERCIAL_FEATURES, reserveCommunicationAttempt } from '../billing/access';
import { USAGE_METRICS } from '../billing/usage';
import { prisma } from '../lib/prisma';
import { toE164 } from '../lib/phone';
import { placeBolnaCall } from './bolnaClient';

export interface BolnaCallTenantContext {
  organizationId: string;
  clinicId: string;
  idempotencyKey: string;
  appointmentId?: string;
  patientId?: string;
  purpose?: string;
  defaultCallingCode?: string;
}

export interface BolnaCallResult {
  attemptId: string;
  callId: string;
  status: string;
  duplicate: boolean;
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function getBolnaMaxCallSeconds(): number {
  const raw = process.env.BOLNA_MAX_OUTBOUND_CALL_SECONDS ?? process.env.BOLNA_MAX_INBOUND_CALL_SECONDS ?? '900';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 7_200) {
    throw new Error('BOLNA_MAX_OUTBOUND_CALL_SECONDS must be an integer from 60 to 7200');
  }
  return value;
}

export function getBolnaInboundReservationSeconds(): number {
  const raw = process.env.BOLNA_MAX_INBOUND_CALL_SECONDS ?? '900';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 7_200) {
    throw new Error('BOLNA_MAX_INBOUND_CALL_SECONDS must be an integer from 60 to 7200');
  }
  return value;
}

async function resolveBolnaOutboundResources(organizationId: string, clinicId: string) {
  const baseWhere = {
    organizationId,
    provider: 'bolna',
    status: 'active',
    providerAccount: { status: 'active' },
  } satisfies Prisma.ProviderResourceWhereInput;

  const phone =
    (await prisma.providerResource.findFirst({
      where: { ...baseWhere, clinicId, resourceType: 'phone_number' },
      orderBy: { createdAt: 'asc' },
    })) ??
    (await prisma.providerResource.findFirst({
      where: { ...baseWhere, clinicId: null, resourceType: 'phone_number' },
      orderBy: { createdAt: 'asc' },
    }));
  if (!phone) throw new Error('No active Bolna phone number is configured for this clinic');

  const config = asRecord(phone.config);
  const agentId = typeof config.agentId === 'string' ? config.agentId : null;
  if (!agentId) throw new Error('The Bolna phone number is missing its bound agentId');

  return { phoneResourceId: phone.id, phoneNumber: phone.externalId, agentId };
}

export async function placeBolnaOutboundCall(
  context: BolnaCallTenantContext,
  patientPhone: string,
  userData: Record<string, string> = {}
): Promise<BolnaCallResult> {
  if (!context.organizationId || !context.clinicId || !context.idempotencyKey) {
    throw new Error('Bolna tenant context and idempotencyKey are required');
  }

  const clinic = await prisma.clinic.findFirst({
    where: { id: context.clinicId, organizationId: context.organizationId, status: 'active' },
    select: { defaultCallingCode: true },
  });
  if (!clinic) throw new Error('Clinic is not active in the specified organization');

  const destination = toE164(patientPhone, context.defaultCallingCode ?? clinic.defaultCallingCode);

  const previous = await prisma.communicationAttempt.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: context.organizationId, idempotencyKey: context.idempotencyKey } },
  });
  if (previous) {
    if (
      previous.provider !== 'bolna' ||
      previous.channel !== 'voice' ||
      previous.direction !== 'outbound' ||
      previous.clinicId !== context.clinicId ||
      previous.destination !== destination
    ) {
      throw new Error('Bolna idempotency key was reused for a different operation');
    }
    if (previous.externalId && !['pending', 'failed', 'unknown', 'dispatching'].includes(previous.status)) {
      return { attemptId: previous.id, callId: previous.externalId, status: previous.status, duplicate: true };
    }
    if (!['pending', 'failed'].includes(previous.status)) {
      throw new Error(`Bolna dispatch ${context.idempotencyKey} is already in progress or has an ambiguous result`);
    }
  }

  const resources = await resolveBolnaOutboundResources(context.organizationId, context.clinicId);
  const maxDurationSeconds = getBolnaMaxCallSeconds();

  const attempt = await reserveCommunicationAttempt({
    organizationId: context.organizationId,
    clinicId: context.clinicId,
    idempotencyKey: context.idempotencyKey,
    feature: COMMERCIAL_FEATURES.VOICE,
    metric: USAGE_METRICS.VOICE_SECONDS,
    estimatedQuantity: maxDurationSeconds,
    unit: 'second',
    attempt: {
      providerResourceId: resources.phoneResourceId,
      patientId: context.patientId,
      appointmentId: context.appointmentId,
      provider: 'bolna',
      channel: 'voice',
      direction: 'outbound',
      status: 'pending',
      destination,
      origin: resources.phoneNumber,
      request: { purpose: context.purpose ?? 'transactional', agentId: resources.agentId, maxDurationSeconds },
    },
  });

  if (attempt.externalId && !['pending', 'failed', 'unknown', 'dispatching'].includes(attempt.status)) {
    return { attemptId: attempt.id, callId: attempt.externalId, status: attempt.status, duplicate: true };
  }

  const claimed = await prisma.communicationAttempt.updateMany({
    where: { id: attempt.id, status: { in: ['pending', 'failed'] }, organization: { status: { in: ['active', 'past_due_grace'] } } },
    data: { status: 'dispatching', startedAt: new Date(), errorCode: null, errorMessage: null },
  });
  if (claimed.count !== 1) {
    throw new Error(`Bolna dispatch ${context.idempotencyKey} is already in progress or has an ambiguous result`);
  }

  try {
    const result = await placeBolnaCall({
      agentId: resources.agentId,
      recipientPhoneNumber: destination,
      fromPhoneNumber: resources.phoneNumber,
      userData,
    });
    if (!result.callId) {
      await prisma.communicationAttempt.update({
        where: { id: attempt.id },
        data: { status: 'unknown', errorMessage: 'Bolna accepted the request without returning a call id' },
      });
      throw new Error('Bolna did not return a call id');
    }
    await prisma.communicationAttempt.update({
      where: { id: attempt.id },
      data: { externalId: result.callId, status: result.status, response: { id: result.callId, status: result.status } },
    });
    return { attemptId: attempt.id, callId: result.callId, status: result.status, duplicate: false };
  } catch (error) {
    const current = await prisma.communicationAttempt.findUnique({ where: { id: attempt.id }, select: { status: true } });
    if (current?.status === 'dispatching') {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Bolna request failed';
      await prisma.communicationAttempt.update({
        where: { id: attempt.id },
        data: { status: 'unknown', errorMessage: message, endedAt: new Date() },
      });
    }
    throw error;
  }
}
