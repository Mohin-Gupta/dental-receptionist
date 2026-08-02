import { prisma } from '../lib/prisma';
import {
  markWebhookFailed,
  markWebhookProcessed,
  markWebhookProcessing,
  readWebhookPayload,
  receiveProviderWebhook,
} from '../services/providerWebhookInbox';
import { BillingProjectionError, processRazorpayEvent } from './projection';
import {
  verifyRazorpayWebhook,
  type RazorpayWebhookEvent,
} from './razorpayWebhook';

const PROVIDER = 'razorpay';
const MAX_PROCESSING_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;

function retryAt(attempt: number): Date {
  const delayMs = Math.min(
    60_000 * 2 ** Math.max(0, attempt - 1),
    MAX_RETRY_DELAY_MS
  );
  return new Date(Date.now() + delayMs);
}

export interface RazorpayWebhookHandlingResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export async function handleRazorpayWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  eventIdHeader: string
): Promise<RazorpayWebhookHandlingResult> {
  const verified = verifyRazorpayWebhook(
    rawBody,
    signatureHeader,
    eventIdHeader
  );
  const received = await receiveProviderWebhook({
    provider: PROVIDER,
    externalEventId: verified.eventId,
    idempotencyKey: verified.eventId,
    eventType: verified.event.event,
    signatureValid: true,
    payload: verified.event,
    headers: {
      'x-razorpay-event-id': verified.eventId,
    },
  });

  // Razorpay retries slow/non-2xx webhooks. Persist the verified raw event and
  // acknowledge immediately; canonical provider reads and tenant projection
  // happen in the worker.
  return {
    httpStatus: received.duplicate ? 200 : 202,
    body: {
      received: true,
      duplicate: received.duplicate,
      eventId: verified.eventId,
    },
  };
}

export async function processPendingRazorpayWebhooks(limit = 100) {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const events = await prisma.providerWebhookEvent.findMany({
    where: {
      provider: PROVIDER,
      signatureValid: true,
      payloadPurgedAt: null,
      OR: [
        { status: 'received' },
        {
          status: 'failed',
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: now } },
          ],
        },
        { status: 'processing', processingStartedAt: { lt: staleBefore } },
      ],
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: boundedLimit,
  });

  let processed = 0;
  let failed = 0;
  let quarantined = 0;
  for (const stored of events) {
    if (stored.processingAttempts >= MAX_PROCESSING_ATTEMPTS) {
      const terminal = await prisma.providerWebhookEvent.updateMany({
        where: {
          id: stored.id,
          processingAttempts: { gte: MAX_PROCESSING_ATTEMPTS },
          OR: [
            { status: 'received' },
            {
              status: 'failed',
              OR: [
                { nextAttemptAt: null },
                { nextAttemptAt: { lte: now } },
              ],
            },
            {
              status: 'processing',
              processingStartedAt: { lt: staleBefore },
            },
          ],
        },
        data: {
          status: 'quarantined',
          processingStartedAt: null,
          nextAttemptAt: null,
          lastError: `Razorpay webhook exceeded ${MAX_PROCESSING_ATTEMPTS} processing attempts`,
        },
      });
      if (terminal.count === 1) quarantined += 1;
      continue;
    }

    const claimed = await markWebhookProcessing(stored.id, undefined, false);
    if (!claimed) continue;

    try {
      const payload = readWebhookPayload(stored) as RazorpayWebhookEvent;
      const result = await processRazorpayEvent(payload, stored.idempotencyKey);
      await markWebhookProcessed(
        stored,
        result,
        typeof result.organizationId === 'string'
          ? { organizationId: result.organizationId }
          : undefined
      );
      processed += 1;
    } catch (error) {
      const nonRetryable = error instanceof BillingProjectionError &&
        !error.retryable;
      const attempt = stored.processingAttempts + 1;
      const exhausted = attempt >= MAX_PROCESSING_ATTEMPTS;
      const shouldQuarantine = nonRetryable || exhausted;
      await markWebhookFailed(
        stored.id,
        error,
        shouldQuarantine ? 'quarantined' : 'failed',
        shouldQuarantine ? null : retryAt(attempt)
      );
      if (shouldQuarantine) quarantined += 1;
      else failed += 1;
    }
  }

  return {
    selected: events.length,
    processed,
    failed,
    quarantined,
  };
}
