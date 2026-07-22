import { Prisma } from '@prisma/client';
import { type Request } from 'express';
import twilio from 'twilio';
import { z } from 'zod';
import { recordProviderCost, recordUsageEvent, USAGE_METRICS } from '../billing/usage';
import { prisma } from '../lib/prisma';
import {
  markWebhookFailed,
  markWebhookProcessed,
  markWebhookProcessing,
  receiveProviderWebhook,
} from '../services/providerWebhookInbox';
import {
  decryptTwilioProviderCredentials,
  getTwilioInboundWebhookUrl,
  getTwilioStatusCallbackUrl,
} from '../services/twilio';
import { recordCommunicationPreference } from '../services/communicationPreferences';
import { createRouter } from '../lib/asyncRouter';

const router = createRouter();

const accountSidPattern = /^AC[0-9a-f]{32}$/i;
const messageSidPattern = /^(?:SM|MM)[0-9a-f]{32}$/i;
const messagingServiceSidPattern = /^MG[0-9a-f]{32}$/i;
const e164Pattern = /^\+[1-9]\d{6,14}$/;
const messageStatuses = [
  'accepted',
  'scheduled',
  'queued',
  'sending',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'read',
  'partially_delivered',
  'canceled',
] as const;

type MessageStatus = (typeof messageStatuses)[number];

const callbackSchema = z.object({
  AccountSid: z.string().regex(accountSidPattern),
  MessageSid: z.string().regex(messageSidPattern),
  MessageStatus: z.enum(messageStatuses),
  ErrorCode: z.preprocess(
    value => value === '' || value === null ? undefined : value,
    z.string().trim().regex(/^\d+$/).max(20).optional()
  ),
}).passthrough();

const inboundMessageSchema = z.object({
  AccountSid: z.string().regex(accountSidPattern),
  MessageSid: z.string().regex(messageSidPattern),
  From: z.string().trim().regex(e164Pattern),
  To: z.string().trim().regex(e164Pattern),
  MessagingServiceSid: z.preprocess(
    value => value === '' || value === null ? undefined : value,
    z.string().regex(messagingServiceSidPattern).optional()
  ),
  OptOutType: z.preprocess(
    value => value === '' || value === null ? undefined : value,
    z.enum(['STOP', 'START', 'HELP']).optional()
  ),
}).passthrough();

const statusRank: Record<MessageStatus, number> = {
  accepted: 10,
  scheduled: 15,
  queued: 20,
  sending: 30,
  sent: 40,
  partially_delivered: 60,
  undelivered: 60,
  failed: 60,
  canceled: 60,
  delivered: 70,
  read: 80,
};

const terminalStatuses = new Set<MessageStatus>([
  'partially_delivered',
  'undelivered',
  'failed',
  'canceled',
  'delivered',
  'read',
]);

const billableStatuses = new Set<MessageStatus>([
  'sent',
  ...terminalStatuses,
]);

const statusesThatMustHaveSegments = new Set<MessageStatus>([
  'sent',
  'delivered',
  'undelivered',
  'read',
  'partially_delivered',
]);

function stringField(body: unknown, name: string): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

function normalizeCallbackBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const form = body as Record<string, unknown>;
  return {
    ...form,
    MessageStatus: form.MessageStatus ?? form.SmsStatus,
  };
}

function auditHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'user-agent']) {
    const value = req.header(name);
    if (value) headers[name] = value.slice(0, 500);
  }
  return headers;
}

function emptyTwiml(res: import('express').Response) {
  return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

function allowedCurrentStatuses(incoming: MessageStatus): string[] {
  const nonterminal = [
    'pending',
    'dispatching',
    'unknown',
    ...messageStatuses.filter(status => !terminalStatuses.has(status)),
  ];
  const allowed = nonterminal.filter(status => {
    if (!(status in statusRank)) return true;
    return statusRank[status as MessageStatus] <= statusRank[incoming];
  });

  if (terminalStatuses.has(incoming)) allowed.push(incoming);
  // A read receipt is a valid progression beyond delivery.
  if (incoming === 'read') allowed.push('delivered');
  return [...new Set(allowed)];
}

async function advanceAttemptStatus(
  attemptId: string,
  incoming: MessageStatus,
  errorCode?: string | null
): Promise<string> {
  const terminal = terminalStatuses.has(incoming);
  const failed = ['failed', 'undelivered', 'canceled'].includes(incoming);
  await prisma.communicationAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: allowedCurrentStatuses(incoming) },
    },
    data: {
      status: incoming,
      errorCode: errorCode ?? null,
      ...(!failed ? { errorMessage: null } : {}),
      ...(terminal ? { endedAt: new Date() } : {}),
    },
  });

  const current = await prisma.communicationAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { status: true },
  });
  return current.status;
}

function parseSegments(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error('Twilio returned an invalid segment count');
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error('Twilio returned an invalid segment count');
  }
  return value;
}

function priceToMicros(raw: string): bigint {
  const price = new Prisma.Decimal(raw);
  if (!price.isFinite()) throw new Error('Twilio returned an invalid message price');
  return BigInt(price.abs().mul(1_000_000).toFixed(0));
}

async function recordFinalMessageUsage(input: {
  accountSid: string;
  authToken: string;
  messageSid: string;
  attempt: {
    id: string;
    organizationId: string;
    clinicId: string | null;
    providerResourceId: string | null;
  };
}) {
  const client = twilio(input.accountSid, input.authToken);
  const message = await client.messages(input.messageSid).fetch();
  if (message.sid !== input.messageSid || message.accountSid !== input.accountSid) {
    throw new Error('Twilio returned a message from a different provider account');
  }

  const fetchedStatus = z.enum(messageStatuses).safeParse(message.status);
  const effectiveStatus = fetchedStatus.success
    ? await advanceAttemptStatus(
        input.attempt.id,
        fetchedStatus.data,
        message.errorCode ? String(message.errorCode) : null
      )
    : undefined;
  const segments = parseSegments(message.numSegments);
  if (
    fetchedStatus.success &&
    statusesThatMustHaveSegments.has(fetchedStatus.data) &&
    segments === 0
  ) {
    throw new Error('Twilio message segment count is not available yet');
  }
  const occurredAt = message.dateUpdated instanceof Date
    ? message.dateUpdated
    : new Date();

  await prisma.communicationAttempt.update({
    where: { id: input.attempt.id },
    data: {
      segmentCount: segments,
      response: {
        sid: input.messageSid,
        status: effectiveStatus ?? message.status,
        segments,
        priceUnit: message.priceUnit || null,
      },
    },
  });

  let usageEvent: Awaited<ReturnType<typeof recordUsageEvent>> | null = null;
  if (segments > 0) {
    usageEvent = await recordUsageEvent({
      organizationId: input.attempt.organizationId,
      clinicId: input.attempt.clinicId,
      providerResourceId: input.attempt.providerResourceId,
      communicationAttemptId: input.attempt.id,
      metric: USAGE_METRICS.SMS_SEGMENTS,
      quantity: segments,
      unit: 'segment',
      source: 'twilio_message_resource',
      externalEventId: input.messageSid,
      idempotencyKey: `twilio:${input.messageSid}:sms-segments`,
      occurredAt,
      metadata: { direction: 'outbound' },
    });
  }

  const rawPrice = typeof message.price === 'string' ? message.price.trim() : '';
  const currency = typeof message.priceUnit === 'string'
    ? message.priceUnit.trim().toUpperCase()
    : '';
  if (rawPrice && currency) {
    await recordProviderCost({
      organizationId: input.attempt.organizationId,
      clinicId: input.attempt.clinicId,
      providerResourceId: input.attempt.providerResourceId,
      communicationAttemptId: input.attempt.id,
      usageEventId: usageEvent?.id ?? null,
      provider: 'twilio',
      costType: 'sms_message',
      quantity: segments || undefined,
      unit: segments ? 'segment' : undefined,
      amountMicros: priceToMicros(rawPrice),
      currency,
      externalEventId: input.messageSid,
      idempotencyKey: `${input.messageSid}:reported-cost`,
      occurredAt,
      metadata: { reportedBy: 'message_resource' },
    });
  }

  if (fetchedStatus.success && terminalStatuses.has(fetchedStatus.data)) {
    await prisma.communicationAttempt.update({
      where: { id: input.attempt.id },
      data: { usageFinalizedAt: new Date() },
    });
  }

  return { status: effectiveStatus ?? message.status, segments };
}

router.post('/webhook/twilio/message-status', async (req, res) => {
  // AccountSid is used only to select a candidate verification key. It does not
  // establish tenant ownership until the Twilio signature has validated.
  const untrustedAccountSid = stringField(req.body, 'AccountSid');
  if (!untrustedAccountSid || !accountSidPattern.test(untrustedAccountSid)) {
    return res.status(400).json({ error: 'Invalid callback payload' });
  }

  const providerAccount = await prisma.providerAccount.findUnique({
    where: {
      provider_externalAccountId: {
        provider: 'twilio',
        externalAccountId: untrustedAccountSid,
      },
    },
  });
  if (!providerAccount) {
    return res.status(403).json({ error: 'Invalid callback signature' });
  }

  let credentials: ReturnType<typeof decryptTwilioProviderCredentials>;
  let callbackUrl: string;
  try {
    credentials = decryptTwilioProviderCredentials(providerAccount);
    callbackUrl = getTwilioStatusCallbackUrl();
  } catch {
    return res.status(503).json({ error: 'Callback verification is unavailable' });
  }

  const signature = req.header('x-twilio-signature') ?? '';
  let signatureValid = false;
  try {
    signatureValid = twilio.validateRequest(
      credentials.authToken,
      signature,
      callbackUrl,
      req.body as Record<string, unknown>
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return res.status(403).json({ error: 'Invalid callback signature' });

  const parsed = callbackSchema.safeParse(normalizeCallbackBody(req.body));
  if (!parsed.success || parsed.data.AccountSid !== credentials.accountSid) {
    return res.status(400).json({ error: 'Invalid callback payload' });
  }
  const callback = parsed.data;
  const idempotencyKey = `${callback.MessageSid}:status:${callback.MessageStatus}`;
  const received = await receiveProviderWebhook({
    provider: 'twilio',
    idempotencyKey,
    externalEventId: callback.MessageSid,
    eventType: `message.${callback.MessageStatus}`,
    signatureValid: true,
    payload: callback,
    headers: auditHeaders(req),
  });

  if (received.event.status === 'processed') {
    return res.json({ received: true, duplicate: true });
  }

  const attempt = await prisma.communicationAttempt.findUnique({
    where: {
      provider_externalId: {
        provider: 'twilio',
        externalId: callback.MessageSid,
      },
    },
    include: {
      providerResource: {
        select: {
          id: true,
          organizationId: true,
          provider: true,
          providerAccountId: true,
        },
      },
    },
  });

  const attribution = {
    organizationId: providerAccount.organizationId,
    providerAccountId: providerAccount.id,
    providerResourceId: attempt?.providerResourceId ?? null,
    communicationAttemptId: attempt?.id ?? null,
  };
  const belongsToAccount = Boolean(
    attempt &&
    attempt.organizationId === providerAccount.organizationId &&
    attempt.provider === 'twilio' &&
    attempt.channel === 'sms' &&
    attempt.providerResource?.organizationId === providerAccount.organizationId &&
    attempt.providerResource.provider === 'twilio' &&
    attempt.providerResource.providerAccountId === providerAccount.id
  );

  if (!attempt || !belongsToAccount) {
    const claimed = await markWebhookProcessing(received.event.id, attribution);
    if (claimed) {
      await markWebhookFailed(
        received.event.id,
        new Error('Twilio message attribution is unavailable or mismatched'),
        'quarantined'
      );
    }
    // A valid callback can race the outbound response update, so ask Twilio to
    // retry without accepting an unattributed event.
    return res.status(attempt ? 403 : 503).json({ error: 'Message attribution unavailable' });
  }

  const claimed = await markWebhookProcessing(received.event.id, attribution);
  if (!claimed) return res.status(202).json({ received: true, processing: true });

  try {
    const callbackStatus = await advanceAttemptStatus(
      attempt.id,
      callback.MessageStatus,
      callback.ErrorCode ?? null
    );
    if (
      (callback.ErrorCode === '21610' || callback.ErrorCode === '30630') &&
      attempt.destination
    ) {
      await recordCommunicationPreference({
        organizationId: attempt.organizationId,
        clinicId: attempt.clinicId,
        channel: 'sms',
        normalizedAddress: attempt.destination,
        status: 'opted_out',
        source: 'twilio_status_callback',
        providerEventId: callback.MessageSid,
      });
    }
    let result: { status: string; segments?: number } = { status: callbackStatus };
    if (billableStatuses.has(callback.MessageStatus)) {
      result = await recordFinalMessageUsage({
        accountSid: credentials.accountSid,
        authToken: credentials.authToken,
        messageSid: callback.MessageSid,
        attempt: {
          id: attempt.id,
          organizationId: attempt.organizationId,
          clinicId: attempt.clinicId,
          providerResourceId: attempt.providerResourceId,
        },
      });
    }

    await markWebhookProcessed(received.event, { received: true, ...result });
    return res.json({ received: true });
  } catch (error) {
    await markWebhookFailed(received.event.id, error);
    console.error('Twilio status callback processing failed', {
      eventId: received.event.id,
      status: callback.MessageStatus,
    });
    return res.status(500).json({ error: 'Callback processing failed' });
  }
});

router.post('/webhook/twilio/inbound', async (req, res) => {
  // AccountSid only selects a candidate signing key. Tenant attribution is
  // accepted after both the Twilio signature and a tenant-owned To/service
  // resource have been verified.
  const untrustedAccountSid = stringField(req.body, 'AccountSid');
  if (!untrustedAccountSid || !accountSidPattern.test(untrustedAccountSid)) {
    return res.status(400).json({ error: 'Invalid inbound message payload' });
  }
  const providerAccount = await prisma.providerAccount.findUnique({
    where: {
      provider_externalAccountId: {
        provider: 'twilio',
        externalAccountId: untrustedAccountSid,
      },
    },
  });
  if (!providerAccount) {
    return res.status(403).json({ error: 'Invalid callback signature' });
  }

  let credentials: ReturnType<typeof decryptTwilioProviderCredentials>;
  let webhookUrl: string;
  try {
    credentials = decryptTwilioProviderCredentials(providerAccount);
    webhookUrl = getTwilioInboundWebhookUrl();
  } catch {
    return res.status(503).json({ error: 'Callback verification is unavailable' });
  }

  const signature = req.header('x-twilio-signature') ?? '';
  let signatureValid = false;
  try {
    signatureValid = twilio.validateRequest(
      credentials.authToken,
      signature,
      webhookUrl,
      req.body as Record<string, unknown>
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return res.status(403).json({ error: 'Invalid callback signature' });

  const parsed = inboundMessageSchema.safeParse(req.body);
  if (!parsed.success || parsed.data.AccountSid !== credentials.accountSid) {
    return res.status(400).json({ error: 'Invalid inbound message payload' });
  }
  const callback = parsed.data;
  const preferenceEvent = callback.OptOutType === 'STOP' || callback.OptOutType === 'START';

  const [phoneResource, serviceResource] = await Promise.all([
    prisma.providerResource.findUnique({
      where: {
        provider_resourceType_externalId: {
          provider: 'twilio',
          resourceType: 'phone_number',
          externalId: callback.To,
        },
      },
      include: { clinic: { select: { status: true } } },
    }),
    callback.MessagingServiceSid
      ? prisma.providerResource.findUnique({
          where: {
            provider_resourceType_externalId: {
              provider: 'twilio',
              resourceType: 'messaging_service',
              externalId: callback.MessagingServiceSid,
            },
          },
          include: { clinic: { select: { status: true } } },
        })
      : null,
  ]);
  const candidates = [phoneResource, serviceResource].filter(
    (candidate): candidate is NonNullable<typeof phoneResource> => Boolean(candidate)
  );
  const mismatched = candidates.some(resource =>
    resource.organizationId !== providerAccount.organizationId ||
    resource.providerAccountId !== providerAccount.id
  );
  const attributedResource = candidates.find(candidate =>
    candidate.organizationId === providerAccount.organizationId &&
    candidate.providerAccountId === providerAccount.id
  ) ?? null;
  const resource = attributedResource && (
    preferenceEvent || (
      providerAccount.status === 'active' &&
      attributedResource.status === 'active' &&
      (!attributedResource.clinic || attributedResource.clinic.status === 'active')
    )
  ) ? attributedResource : null;

  const idempotencyKey = `${callback.MessageSid}:inbound`;
  const received = await receiveProviderWebhook({
    provider: 'twilio',
    idempotencyKey,
    externalEventId: callback.MessageSid,
    eventType: callback.OptOutType
      ? `message.preference.${callback.OptOutType.toLowerCase()}`
      : 'message.inbound_ignored',
    signatureValid: true,
    payload: {
      schemaVersion: 1,
      messageSid: callback.MessageSid,
      optOutType: callback.OptOutType ?? null,
      providerResourceId: resource?.id ?? null,
      // Body, From, and To are deliberately excluded from the durable inbox.
    },
    headers: auditHeaders(req),
  });
  if (received.event.status === 'processed') return emptyTwiml(res);

  const attribution = {
    organizationId: providerAccount.organizationId,
    providerAccountId: providerAccount.id,
    providerResourceId: resource?.id ?? null,
  };
  if ((!resource && !preferenceEvent) || mismatched) {
    const claimed = await markWebhookProcessing(received.event.id, attribution);
    if (claimed) {
      await markWebhookFailed(
        received.event.id,
        new Error('Inbound Twilio resource attribution is unavailable or mismatched'),
        'quarantined'
      );
    }
    return res.status(403).json({ error: 'Inbound resource attribution unavailable' });
  }

  const claimed = await markWebhookProcessing(received.event.id, attribution);
  if (!claimed) return res.status(409).json({ error: 'Inbound message is already processing' });

  try {
    if (preferenceEvent) {
      await recordCommunicationPreference({
        organizationId: providerAccount.organizationId,
        clinicId: resource?.clinicId ?? null,
        channel: 'sms',
        normalizedAddress: callback.From,
        status: callback.OptOutType === 'STOP' ? 'opted_out' : 'opted_in',
        source: 'twilio_advanced_opt_out',
        providerEventId: callback.MessageSid,
      });
    }
    await markWebhookProcessed(received.event, {
      received: true,
      preferenceUpdated: preferenceEvent,
    });
    return emptyTwiml(res);
  } catch (error) {
    await markWebhookFailed(received.event.id, error);
    console.error('Twilio inbound preference processing failed', { eventId: received.event.id });
    return res.status(500).json({ error: 'Inbound message processing failed' });
  }
});

export default router;
