import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { processPendingRazorpayWebhooks } from '../src/billing/webhookHandler';
import { prisma } from '../src/lib/prisma';

function replaceMethod(
  context: { after(cleanup: () => unknown): void },
  target: Record<PropertyKey, unknown>,
  method: PropertyKey,
  replacement: (...args: any[]) => any
): void {
  const original = target[method];
  target[method] = replacement;
  context.after(() => {
    target[method] = original;
  });
}

test('quarantines a stale processing lease that crashed on the final attempt', async context => {
  const eventId = '50000000-0000-4000-8000-000000000005';
  const staleStartedAt = new Date(Date.now() - 10 * 60_000);
  let selection: Record<string, any> | null = null;
  let terminalUpdate: Record<string, any> | null = null;

  replaceMethod(
    context,
    prisma.providerWebhookEvent as unknown as Record<PropertyKey, unknown>,
    'findMany',
    async (args: Record<string, any>) => {
      selection = args;
      return [{
        id: eventId,
        organizationId: null,
        providerAccountId: null,
        providerResourceId: null,
        communicationAttemptId: null,
        provider: 'razorpay',
        externalEventId: 'event-final-attempt',
        idempotencyKey: 'event-final-attempt',
        eventType: 'subscription.cancelled',
        signatureValid: true,
        payload: {},
        headers: null,
        response: null,
        status: 'processing',
        processingAttempts: 10,
        processingStartedAt: staleStartedAt,
        nextAttemptAt: null,
        lastError: null,
        receivedAt: new Date(Date.now() - 20 * 60_000),
        processedAt: null,
        payloadPurgedAt: null,
      }];
    }
  );
  replaceMethod(
    context,
    prisma.providerWebhookEvent as unknown as Record<PropertyKey, unknown>,
    'updateMany',
    async (args: Record<string, any>) => {
      terminalUpdate = args;
      return { count: 1 };
    }
  );

  const result = await processPendingRazorpayWebhooks(25);
  const capturedSelection = selection as Record<string, any> | null;
  const capturedTerminalUpdate =
    terminalUpdate as Record<string, any> | null;

  assert.equal(capturedSelection?.where.processingAttempts, undefined);
  assert.equal(capturedSelection?.where.OR[2].status, 'processing');
  assert.deepEqual(
    capturedTerminalUpdate?.where.processingAttempts,
    { gte: 10 }
  );
  assert.equal(capturedTerminalUpdate?.where.id, eventId);
  assert.equal(capturedTerminalUpdate?.data.status, 'quarantined');
  assert.equal(capturedTerminalUpdate?.data.processingStartedAt, null);
  assert.equal(capturedTerminalUpdate?.data.nextAttemptAt, null);
  assert.match(
    capturedTerminalUpdate?.data.lastError,
    /exceeded 10 processing attempts/
  );
  assert.deepEqual(result, {
    selected: 1,
    processed: 0,
    failed: 0,
    quarantined: 1,
  });
});
