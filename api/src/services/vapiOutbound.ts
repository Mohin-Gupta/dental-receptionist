import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import {
  COMMERCIAL_FEATURES,
  reserveCommunicationAttempt,
} from '../billing/access';
import { USAGE_METRICS } from '../billing/usage';
import { prisma } from '../lib/prisma';
import { toE164 } from '../lib/phone';
import { decryptProviderCredentials } from './providerProvisioning';

type JsonRecord = Record<string, unknown>;

export interface VapiCallTenantContext {
  organizationId: string;
  clinicId: string;
  idempotencyKey: string;
  appointmentId?: string;
  patientId?: string;
  purpose?: string;
  defaultCallingCode?: string;
  /** Optional tenant-owned assistant override. It is verified before use. */
  assistantId?: string;
}

export interface VapiCallResult {
  attemptId: string;
  callId: string;
  status: string;
  duplicate: boolean;
}

interface ResolvedVapiResources {
  phoneResourceId?: string;
  phoneNumberId: string;
  assistantId: string;
  apiKey: string;
  legacy: boolean;
}

function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function requestValue(request: Prisma.JsonValue | null, key: string): string | undefined {
  return readString(asRecord(request), key);
}

function readString(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function legacyFallbackAllowed(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_LEGACY_PROVIDER_FALLBACK === 'true'
  );
}

export function getVapiMaxCallSeconds(): number {
  const raw = process.env.VAPI_MAX_OUTBOUND_CALL_SECONDS ?? '900';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 7_200) {
    throw new Error('VAPI_MAX_OUTBOUND_CALL_SECONDS must be an integer from 60 to 7200');
  }
  return value;
}

export function getVapiInboundReservationSeconds(): number {
  const raw = process.env.VAPI_MAX_INBOUND_CALL_SECONDS ?? '900';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 7_200) {
    throw new Error('VAPI_MAX_INBOUND_CALL_SECONDS must be an integer from 60 to 7200');
  }
  return value;
}

async function resolveVapiResources(
  organizationId: string,
  clinicId: string,
  requestedAssistantId?: string
): Promise<ResolvedVapiResources> {
  const baseWhere = {
    organizationId,
    provider: 'vapi',
    status: 'active',
    providerAccount: { status: 'active' },
  } satisfies Prisma.ProviderResourceWhereInput;

  const phone =
    (await prisma.providerResource.findFirst({
      where: { ...baseWhere, clinicId, resourceType: 'phone_number' },
      include: { providerAccount: true },
      orderBy: { createdAt: 'asc' },
    })) ??
    (await prisma.providerResource.findFirst({
      where: { ...baseWhere, clinicId: null, resourceType: 'phone_number' },
      include: { providerAccount: true },
      orderBy: { createdAt: 'asc' },
    }));

  if (phone) {
    const credentials = decryptProviderCredentials(phone.providerAccount);
    if (!('apiKey' in credentials)) {
      throw new Error('The configured Vapi account is missing apiKey');
    }
    const apiKey = credentials.apiKey;

    const assistantWhere: Prisma.ProviderResourceWhereInput = {
      ...baseWhere,
      providerAccountId: phone.providerAccountId,
      resourceType: 'assistant',
      ...(requestedAssistantId ? { externalId: requestedAssistantId } : {}),
    };
    const assistant =
      (await prisma.providerResource.findFirst({
        where: { ...assistantWhere, clinicId },
        orderBy: { createdAt: 'asc' },
      })) ??
      (await prisma.providerResource.findFirst({
        where: { ...assistantWhere, clinicId: null },
        orderBy: { createdAt: 'asc' },
      }));

    if (!assistant) {
      throw new Error(
        requestedAssistantId
          ? 'The requested Vapi assistant is not assigned to this tenant and clinic'
          : 'No active Vapi assistant is configured for this clinic'
      );
    }

    return {
      phoneResourceId: phone.id,
      phoneNumberId: phone.externalId,
      assistantId: assistant.externalId,
      apiKey,
      legacy: false,
    };
  }

  if (legacyFallbackAllowed()) {
    const apiKey = process.env.VAPI_API_KEY;
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
    const assistantId = requestedAssistantId ?? process.env.VAPI_REMINDER_ASSISTANT_ID;
    if (apiKey && phoneNumberId && assistantId) {
      return { apiKey, phoneNumberId, assistantId, legacy: true };
    }
  }

  throw new Error(
    'No active Vapi phone number is configured for this clinic'
  );
}

/** Places a tenant-attributed, idempotent outbound call through Vapi. */
export async function placeOutboundCall(
  context: VapiCallTenantContext,
  patientPhone: string,
  variableValues: Record<string, string> = {}
): Promise<VapiCallResult> {
  if (!context.organizationId || !context.clinicId || !context.idempotencyKey) {
    throw new Error('Vapi tenant context and idempotencyKey are required');
  }

  const clinic = await prisma.clinic.findFirst({
    where: { id: context.clinicId, organizationId: context.organizationId, status: 'active' },
    select: { defaultCallingCode: true },
  });
  if (!clinic) throw new Error('Clinic is not active in the specified organization');

  if (context.appointmentId) {
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: context.appointmentId,
        organizationId: context.organizationId,
        clinicId: context.clinicId,
      },
      select: { id: true },
    });
    if (!appointment) throw new Error('Appointment does not belong to the Vapi tenant context');
  }
  if (context.patientId) {
    const patient = await prisma.patient.findFirst({
      where: { id: context.patientId, organizationId: context.organizationId },
      select: { id: true },
    });
    if (!patient) throw new Error('Patient does not belong to the Vapi tenant context');
  }

  const destination = toE164(
    patientPhone,
    context.defaultCallingCode ?? clinic.defaultCallingCode
  );
  const variableEntries = Object.entries(variableValues).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const variablesDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(variableEntries), 'utf8')
    .digest('hex');
  const previous = await prisma.communicationAttempt.findUnique({
    where: {
      organizationId_idempotencyKey: {
        organizationId: context.organizationId,
        idempotencyKey: context.idempotencyKey,
      },
    },
  });
  if (previous) {
    const mismatched =
      previous.provider !== 'vapi' ||
      previous.channel !== 'voice' ||
      previous.direction !== 'outbound' ||
      previous.clinicId !== context.clinicId ||
      previous.destination !== destination ||
      (requestValue(previous.request, 'variablesDigest') !== undefined &&
        requestValue(previous.request, 'variablesDigest') !== variablesDigest);
    if (mismatched) {
      throw new Error('Vapi idempotency key was reused for a different operation');
    }
    if (previous.externalId && !['pending', 'failed', 'unknown', 'dispatching'].includes(previous.status)) {
      return {
        attemptId: previous.id,
        callId: previous.externalId,
        status: previous.status,
        duplicate: true,
      };
    }
    if (!['pending', 'failed'].includes(previous.status)) {
      throw new Error(
        `Vapi dispatch ${context.idempotencyKey} is already in progress or has an ambiguous result`
      );
    }
  }

  const resources = await resolveVapiResources(
    context.organizationId,
    context.clinicId,
    context.assistantId
  );
  const maxDurationSeconds = getVapiMaxCallSeconds();
  const dispatchRequest: Prisma.InputJsonObject = {
    purpose: context.purpose ?? 'transactional',
    assistantId: resources.assistantId,
    variableNames: Object.keys(variableValues).sort(),
    variablesDigest,
    maxDurationSeconds,
    legacyProviderFallback: resources.legacy,
  };
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
      provider: 'vapi',
      channel: 'voice',
      direction: 'outbound',
      status: 'pending',
      destination,
      origin: resources.phoneNumberId,
      request: dispatchRequest,
    },
  });

  if (attempt.externalId && !['pending', 'failed', 'unknown', 'dispatching'].includes(attempt.status)) {
    return {
      attemptId: attempt.id,
      callId: attempt.externalId,
      status: attempt.status,
      duplicate: true,
    };
  }

  const claimed = await prisma.communicationAttempt.updateMany({
    where: {
      id: attempt.id,
      status: { in: ['pending', 'failed'] },
      organization: { status: { in: ['active', 'past_due_grace'] } },
    },
    data: {
      status: 'dispatching',
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
      providerResourceId: resources.phoneResourceId,
      origin: resources.phoneNumberId,
      request: {
        ...asRecord(attempt.request),
        ...dispatchRequest,
      } as Prisma.InputJsonObject,
    },
  });
  if (claimed.count !== 1) {
    throw new Error(
      `Vapi dispatch ${context.idempotencyKey} is already in progress or has an ambiguous result`
    );
  }

  const body: Record<string, unknown> = {
    phoneNumberId: resources.phoneNumberId,
    customer: { number: destination },
    assistantId: resources.assistantId,
  };
  body.assistantOverrides = {
    maxDurationSeconds,
    ...(Object.keys(variableValues).length > 0 ? { variableValues } : {}),
  };

  try {
    const response = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resources.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = (await response.text()).slice(0, 500);
      await prisma.communicationAttempt.update({
        where: { id: attempt.id },
        data: {
          status: response.status >= 400 && response.status < 500 ? 'failed' : 'unknown',
          errorCode: String(response.status),
          errorMessage: errorBody || 'Vapi rejected the outbound call',
          endedAt: new Date(),
        },
      });
      throw new Error(`Vapi outbound call failed with status ${response.status}`);
    }

    const data = (await response.json()) as { id?: unknown; status?: unknown };
    if (typeof data.id !== 'string' || !data.id) {
      await prisma.communicationAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'unknown',
          errorMessage: 'Vapi accepted the request without returning a call id',
        },
      });
      throw new Error('Vapi did not return a call id');
    }
    const status = typeof data.status === 'string' ? data.status : 'accepted';
    await prisma.communicationAttempt.update({
      where: { id: attempt.id },
      data: {
        externalId: data.id,
        status,
        response: { id: data.id, status },
      },
    });

    return {
      attemptId: attempt.id,
      callId: data.id,
      status,
      duplicate: false,
    };
  } catch (error) {
    const current = await prisma.communicationAttempt.findUnique({
      where: { id: attempt.id },
      select: { status: true },
    });
    if (current?.status === 'dispatching') {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Vapi request failed';
      await prisma.communicationAttempt.update({
        where: { id: attempt.id },
        data: { status: 'unknown', errorMessage: message, endedAt: new Date() },
      });
    }
    throw error;
  }
}
