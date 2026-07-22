import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import twilio from 'twilio';
import { decryptSecret } from '../auth/secretBox';
import {
  COMMERCIAL_FEATURES,
  reserveCommunicationAttempt,
} from '../billing/access';
import { USAGE_METRICS } from '../billing/usage';
import { prisma } from '../lib/prisma';
import { toE164 } from '../lib/phone';
import {
  assertCommunicationAllowed,
  recordCommunicationPreference,
  type CommunicationConsentPolicy,
} from './communicationPreferences';

const SUCCESSFUL_ATTEMPT_STATUSES = new Set([
  'accepted',
  'queued',
  'sending',
  'sent',
  'delivered',
]);

type JsonRecord = Record<string, unknown>;

export interface SmsTenantContext {
  organizationId: string;
  clinicId: string;
  idempotencyKey: string;
  appointmentId?: string;
  patientId?: string;
  purpose?: string;
  consentPolicy?: CommunicationConsentPolicy;
  defaultCallingCode?: string;
}

export interface SmsSendResult {
  attemptId: string;
  externalId: string;
  status: string;
  duplicate: boolean;
}

interface ResolvedTwilioResource {
  providerResourceId?: string;
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
  legacy: boolean;
}

export interface TwilioProviderCredentials {
  accountSid: string;
  authToken: string;
}

export interface TwilioProviderAccountRecord {
  organizationId: string;
  externalAccountId: string;
  credentialsEncrypted: string | null;
}

function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function readString(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function requestValue(request: Prisma.JsonValue | null, key: string): string | undefined {
  return readString(asRecord(request), key);
}

function parseCredentials(
  encrypted: string | null,
  organizationId: string,
  provider: string
): JsonRecord {
  if (!encrypted) {
    throw new Error(`The ${provider} provider account has no configured credentials`);
  }

  let plaintext: string;
  try {
    plaintext = decryptSecret(
      encrypted,
      `provider-account:${organizationId}:${provider}`
    );
  } catch {
    throw new Error(`The ${provider} provider credentials could not be decrypted`);
  }

  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as JsonRecord;
  } catch {
    throw new Error(`The ${provider} provider credentials have an invalid format`);
  }
}

/** Shared by outbound dispatch and the status callback verifier. */
export function decryptTwilioProviderCredentials(
  account: TwilioProviderAccountRecord
): TwilioProviderCredentials {
  const credentials = parseCredentials(
    account.credentialsEncrypted,
    account.organizationId,
    'twilio'
  );
  const accountSid =
    readString(credentials, 'accountSid', 'account_sid') ?? account.externalAccountId;
  const authToken = readString(credentials, 'authToken', 'auth_token');
  if (!accountSid || !authToken || accountSid !== account.externalAccountId) {
    throw new Error('The tenant Twilio credentials do not match the provider account');
  }
  return { accountSid, authToken };
}

function getTwilioWebhookUrl(pathname: string): string {
  const configured = process.env.PUBLIC_API_URL?.trim();
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_API_URL is required for Twilio status callbacks in production');
  }

  const base = new URL(configured || `http://localhost:${process.env.PORT ?? '3001'}`);
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('PUBLIC_API_URL must use HTTP or HTTPS');
  }
  if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') {
    throw new Error('PUBLIC_API_URL must use HTTPS in production');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error('PUBLIC_API_URL must not contain credentials, a query, or a fragment');
  }
  if (base.pathname !== '/' && base.pathname !== '') {
    throw new Error('PUBLIC_API_URL must be an origin without a path');
  }
  if (!/^[A-Za-z0-9.-]+$/.test(base.hostname)) {
    throw new Error('PUBLIC_API_URL contains an invalid hostname');
  }

  return new URL(pathname, base).toString();
}

export function getTwilioStatusCallbackUrl(): string {
  return getTwilioWebhookUrl('/api/webhook/twilio/message-status');
}

export function getTwilioInboundWebhookUrl(): string {
  return getTwilioWebhookUrl('/api/webhook/twilio/inbound');
}

function legacyFallbackAllowed(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_LEGACY_PROVIDER_FALLBACK === 'true'
  );
}

async function resolveTwilioResource(
  organizationId: string,
  clinicId: string
): Promise<ResolvedTwilioResource> {
  const resourceWhere = {
    organizationId,
    provider: 'twilio',
    resourceType: { in: ['phone_number', 'messaging_service'] },
    status: 'active',
    providerAccount: { status: 'active' },
  } satisfies Prisma.ProviderResourceWhereInput;

  const resource =
    (await prisma.providerResource.findFirst({
      where: { ...resourceWhere, clinicId },
      include: { providerAccount: true },
      orderBy: { createdAt: 'asc' },
    })) ??
    (await prisma.providerResource.findFirst({
      where: { ...resourceWhere, clinicId: null },
      include: { providerAccount: true },
      orderBy: { createdAt: 'asc' },
    }));

  if (resource) {
    const credentials = decryptTwilioProviderCredentials(resource.providerAccount);
    const config = asRecord(resource.config);

    const isMessagingService = resource.resourceType === 'messaging_service';
    return {
      providerResourceId: resource.id,
      accountSid: credentials.accountSid,
      authToken: credentials.authToken,
      messagingServiceSid: isMessagingService
        ? resource.externalId
        : readString(config, 'messagingServiceSid', 'messaging_service_sid'),
      from: isMessagingService
        ? readString(config, 'from', 'phoneNumber')
        : resource.externalId,
      legacy: false,
    };
  }

  if (legacyFallbackAllowed()) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (accountSid && authToken && from) {
      return { accountSid, authToken, from, legacy: true };
    }
  }

  throw new Error(
    'No active tenant-owned Twilio sending resource is configured for this clinic'
  );
}

function errorDetails(error: unknown): {
  code?: string;
  message: string;
  definitelyRejected: boolean;
} {
  if (!error || typeof error !== 'object') {
    return { message: 'Unknown Twilio error', definitelyRejected: false };
  }
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  return {
    code:
      typeof candidate.code === 'string' || typeof candidate.code === 'number'
        ? String(candidate.code)
        : undefined,
    message:
      typeof candidate.message === 'string'
        ? candidate.message.slice(0, 500)
        : 'Twilio request failed',
    // A client-side rejection is safe to retry after configuration/input is fixed.
    // Network and 5xx errors are ambiguous and must not automatically send twice.
    definitelyRejected: status !== undefined && status >= 400 && status < 500,
  };
}

/**
 * Send one tenant-attributed SMS.
 *
 * Callers must provide a stable, business-operation idempotency key. The local
 * attempt row is written before the provider request, so provider usage can
 * never become unattributed. A dispatch left in an ambiguous state fails closed
 * on retry instead of risking a duplicate patient message.
 */
export async function sendSMS(
  context: SmsTenantContext,
  rawTo: string,
  body: string
): Promise<SmsSendResult> {
  if (!context.organizationId || !context.clinicId || !context.idempotencyKey) {
    throw new Error('SMS tenant context and idempotencyKey are required');
  }
  if (!body.trim()) throw new Error('SMS body is required');
  if (body.length > 1_600) throw new Error('SMS body exceeds the provider limit');

  const clinic = await prisma.clinic.findFirst({
    where: {
      id: context.clinicId,
      organizationId: context.organizationId,
    },
    select: { defaultCallingCode: true },
  });
  if (!clinic) throw new Error('Clinic does not belong to the specified organization');

  if (context.appointmentId) {
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: context.appointmentId,
        organizationId: context.organizationId,
        clinicId: context.clinicId,
      },
      select: { id: true },
    });
    if (!appointment) throw new Error('Appointment does not belong to the SMS tenant context');
  }
  if (context.patientId) {
    const patient = await prisma.patient.findFirst({
      where: { id: context.patientId, organizationId: context.organizationId },
      select: { id: true },
    });
    if (!patient) throw new Error('Patient does not belong to the SMS tenant context');
  }

  const destination = toE164(
    rawTo,
    context.defaultCallingCode ?? clinic.defaultCallingCode
  );
  const bodyDigest = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
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
      previous.provider !== 'twilio' ||
      previous.channel !== 'sms' ||
      previous.direction !== 'outbound' ||
      previous.clinicId !== context.clinicId ||
      previous.destination !== destination ||
      (requestValue(previous.request, 'bodyDigest') !== undefined &&
        requestValue(previous.request, 'bodyDigest') !== bodyDigest);
    if (mismatched) {
      throw new Error('SMS idempotency key was reused for a different operation');
    }
    if (SUCCESSFUL_ATTEMPT_STATUSES.has(previous.status) && previous.externalId) {
      return {
        attemptId: previous.id,
        externalId: previous.externalId,
        status: previous.status,
        duplicate: true,
      };
    }
    if (!['pending', 'failed'].includes(previous.status)) {
      throw new Error(
        `SMS dispatch ${context.idempotencyKey} is already in progress or has an ambiguous result`
      );
    }
  }

  await assertCommunicationAllowed({
    organizationId: context.organizationId,
    channel: 'sms',
    normalizedAddress: destination,
    policy: context.consentPolicy,
  });

  const statusCallback = getTwilioStatusCallbackUrl();
  const resource = await resolveTwilioResource(
    context.organizationId,
    context.clinicId
  );
  // UCS-2 concatenated messages have the smallest payload per segment. Using
  // UTF-16 code units / 67 deliberately over-reserves GSM messages so a hard
  // budget cannot be bypassed with concurrent long messages.
  const estimatedSegments = Math.max(1, Math.ceil(body.length / 67));
  const dispatchRequest: Prisma.InputJsonObject = {
    purpose: context.purpose ?? 'transactional',
    bodyLength: body.length,
    bodyDigest,
    statusCallbackConfigured: true,
    legacyProviderFallback: resource.legacy,
  };
  const attempt = await reserveCommunicationAttempt({
    organizationId: context.organizationId,
    clinicId: context.clinicId,
    idempotencyKey: context.idempotencyKey,
    feature: COMMERCIAL_FEATURES.SMS,
    metric: USAGE_METRICS.SMS_SEGMENTS,
    estimatedQuantity: estimatedSegments,
    unit: 'segment',
    attempt: {
      providerResourceId: resource.providerResourceId,
      patientId: context.patientId,
      appointmentId: context.appointmentId,
      provider: 'twilio',
      channel: 'sms',
      direction: 'outbound',
      status: 'pending',
      destination,
      origin: resource.from ?? resource.messagingServiceSid,
      request: dispatchRequest,
    },
  });

  if (SUCCESSFUL_ATTEMPT_STATUSES.has(attempt.status) && attempt.externalId) {
    return {
      attemptId: attempt.id,
      externalId: attempt.externalId,
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
      providerResourceId: resource.providerResourceId,
      origin: resource.from ?? resource.messagingServiceSid,
      request: {
        ...asRecord(attempt.request),
        ...dispatchRequest,
      } as Prisma.InputJsonObject,
    },
  });
  if (claimed.count !== 1) {
    throw new Error(
      `SMS dispatch ${context.idempotencyKey} is already in progress or has an ambiguous result`
    );
  }

  try {
    const client = twilio(resource.accountSid, resource.authToken);
    const message = await client.messages.create({
      body,
      to: destination,
      statusCallback,
      ...(resource.messagingServiceSid
        ? { messagingServiceSid: resource.messagingServiceSid }
        : { from: resource.from! }),
    });
    const status = message.status || 'accepted';

    await prisma.communicationAttempt.update({
      where: { id: attempt.id },
      data: {
        externalId: message.sid,
        status,
        segmentCount:
          typeof message.numSegments === 'string'
            ? Number.parseInt(message.numSegments, 10) || undefined
            : undefined,
        response: { sid: message.sid, status },
      },
    });

    return {
      attemptId: attempt.id,
      externalId: message.sid,
      status,
      duplicate: false,
    };
  } catch (error) {
    const details = errorDetails(error);
    await prisma.communicationAttempt.update({
      where: { id: attempt.id },
      data: {
        status: details.definitelyRejected ? 'failed' : 'unknown',
        errorCode: details.code,
        errorMessage: details.message,
        endedAt: new Date(),
      },
    });
    if (details.code === '21610' || details.code === '30630') {
      await recordCommunicationPreference({
        organizationId: context.organizationId,
        clinicId: context.clinicId,
        channel: 'sms',
        normalizedAddress: destination,
        status: 'opted_out',
        source: 'twilio_send_rejection',
      }).catch(() => {
        // Provider blocking still protects the recipient. Reconciliation and
        // alerts must surface a local preference-write failure without
        // reverting the accurately recorded provider attempt status.
        console.warn('Twilio opt-out preference could not be persisted', {
          organizationId: context.organizationId,
          attemptId: attempt.id,
        });
      });
    }
    // Detailed provider errors are retained on the tenant-scoped attempt; do
    // not leak a provider message that may echo the destination into logs.
    throw new Error('Twilio SMS dispatch failed');
  }
}
