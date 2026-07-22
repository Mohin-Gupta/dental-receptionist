import { prisma } from '../lib/prisma';
import {
  markWebhookFailed,
  markWebhookProcessed,
  markWebhookProcessing,
  receiveProviderWebhook,
} from '../services/providerWebhookInbox';
import { BillingProjectionError, processStripeEvent } from './projection';
import { verifyStripeWebhook } from './stripeWebhook';

export interface StripeWebhookHandlingResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export async function handleStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string
): Promise<StripeWebhookHandlingResult> {
  const stripeEvent = verifyStripeWebhook(rawBody, signatureHeader);
  const received = await receiveProviderWebhook({
    provider: 'stripe',
    externalEventId: stripeEvent.id,
    idempotencyKey: stripeEvent.id,
    eventType: stripeEvent.type,
    signatureValid: true,
    payload: stripeEvent,
  });

  if (received.duplicate && received.event.status === 'processed') {
    return { httpStatus: 200, body: { received: true, duplicate: true } };
  }

  const claimed = await markWebhookProcessing(received.event.id);
  if (!claimed) {
    return {
      // Do not acknowledge a concurrent in-flight claim as completed. If that
      // worker dies, Stripe's retry will reclaim it after the stale timeout.
      httpStatus: 409,
      body: { received: true, duplicate: received.duplicate, processing: true },
    };
  }

  try {
    const result = await processStripeEvent(stripeEvent);
    if (typeof result.organizationId === 'string') {
      await prisma.providerWebhookEvent.update({
        where: { id: received.event.id },
        data: { organizationId: result.organizationId },
      });
    }
    await markWebhookProcessed(received.event, result);
    return { httpStatus: 200, body: { received: true } };
  } catch (error) {
    if (error instanceof BillingProjectionError && !error.retryable) {
      await markWebhookFailed(received.event.id, error, 'quarantined');
      // Retrying cannot repair an ownership or catalog mismatch. Preserve it
      // for operator review and acknowledge so Stripe does not retry for days.
      return { httpStatus: 200, body: { received: true, quarantined: true } };
    }

    await markWebhookFailed(received.event.id, error, 'failed');
    // A non-2xx response asks Stripe to retry transient database/API failures.
    throw error;
  }
}
