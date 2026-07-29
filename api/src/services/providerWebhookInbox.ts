import { Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../auth/secretBox';
import { prisma } from '../lib/prisma';

interface ReceiveWebhookInput {
  provider: string;
  idempotencyKey: string;
  externalEventId?: string | null;
  eventType: string;
  signatureValid: boolean;
  payload: unknown;
  headers?: Record<string, string>;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function purpose(provider: string, idempotencyKey: string, kind: 'payload' | 'response') {
  return `provider-webhook:${provider}:${idempotencyKey}:${kind}`;
}

function protect(value: unknown, encryptionPurpose: string): Prisma.InputJsonObject {
  return {
    protected: 'secret-box-v1',
    ciphertext: encryptSecret(JSON.stringify(value), encryptionPurpose),
  };
}

function unprotect(value: Prisma.JsonValue, encryptionPurpose: string): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).ciphertext === 'string'
  ) {
    const plaintext = decryptSecret(
      (value as Record<string, unknown>).ciphertext as string,
      encryptionPurpose
    );
    return JSON.parse(plaintext);
  }
  return value;
}

export async function receiveProviderWebhook(input: ReceiveWebhookInput) {
  const data = {
    provider: input.provider,
    externalEventId: input.externalEventId ?? null,
    idempotencyKey: input.idempotencyKey,
    eventType: input.eventType,
    signatureValid: input.signatureValid,
    payload: protect(input.payload, purpose(input.provider, input.idempotencyKey, 'payload')),
    headers: input.headers,
    status: 'received',
  } satisfies Prisma.ProviderWebhookEventCreateInput;

  try {
    const event = await prisma.providerWebhookEvent.create({ data });
    return { event, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const event = await prisma.providerWebhookEvent.findUniqueOrThrow({
      where: {
        provider_idempotencyKey: {
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    return { event, duplicate: true };
  }
}

export async function markWebhookProcessing(
  eventId: string,
  attribution?: {
    organizationId: string;
    providerAccountId?: string | null;
    providerResourceId?: string | null;
    communicationAttemptId?: string | null;
  },
  allowQuarantined = true
) {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const now = new Date();
  const claimed = await prisma.providerWebhookEvent.updateMany({
    where: {
      id: eventId,
      OR: [
        { status: 'received' },
        {
          status: 'failed',
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: now } },
          ],
        },
        ...(allowQuarantined ? [{ status: 'quarantined' }] : []),
        { status: 'processing', processingStartedAt: { lt: staleBefore } },
      ],
    },
    data: {
      ...(attribution ?? {}),
      status: 'processing',
      processingStartedAt: new Date(),
      nextAttemptAt: null,
      processingAttempts: { increment: 1 },
      lastError: null,
    },
  });
  return claimed.count === 1;
}

export async function markWebhookProcessed(
  event: { id: string; provider: string; idempotencyKey: string },
  response: unknown,
  attribution?: {
    organizationId?: string | null;
    providerAccountId?: string | null;
    providerResourceId?: string | null;
    communicationAttemptId?: string | null;
  }
) {
  return prisma.providerWebhookEvent.update({
    where: { id: event.id },
    data: {
      ...(attribution ?? {}),
      response: protect(response, purpose(event.provider, event.idempotencyKey, 'response')),
      status: 'processed',
      processingStartedAt: null,
      nextAttemptAt: null,
      processedAt: new Date(),
      lastError: null,
    },
  });
}

export async function markWebhookFailed(
  eventId: string,
  error: unknown,
  status: 'failed' | 'quarantined' = 'failed',
  nextAttemptAt: Date | null = null
) {
  const message = error instanceof Error ? error.message : 'Unknown webhook processing error';
  return prisma.providerWebhookEvent.update({
    where: { id: eventId },
    data: {
      status,
      processingStartedAt: null,
      nextAttemptAt: status === 'failed' ? nextAttemptAt : null,
      lastError: message.slice(0, 1000),
    },
  });
}

export function readWebhookResponse(event: {
  provider: string;
  idempotencyKey: string;
  response: Prisma.JsonValue | null;
}): unknown | null {
  if (event.response === null) return null;
  return unprotect(event.response, purpose(event.provider, event.idempotencyKey, 'response'));
}

export function readWebhookPayload(event: {
  provider: string;
  idempotencyKey: string;
  payload: Prisma.JsonValue;
}): unknown {
  return unprotect(event.payload, purpose(event.provider, event.idempotencyKey, 'payload'));
}
