import { Prisma } from '@prisma/client';
import { getDataRetentionConfig } from '../config/dataRetention';
import { prisma } from '../lib/prisma';

const TERMINAL_COMMUNICATION_STATUSES = [
  'completed',
  'failed',
  'canceled',
  'cancelled',
  'busy',
  'no-answer',
  'delivered',
  'undelivered',
  'partially_delivered',
  'read',
];

function cutoff(now: Date, days: number) {
  return new Date(now.getTime() - days * 86_400_000);
}

async function purgeWebhookPayloads(before: Date, batchSize: number, now: Date) {
  const rows = await prisma.providerWebhookEvent.findMany({
    where: {
      payloadPurgedAt: null,
      receivedAt: { lte: before },
      status: { in: ['processed', 'failed', 'quarantined'] },
    },
    orderBy: { receivedAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  if (!rows.length) return 0;
  await prisma.providerWebhookEvent.updateMany({
    where: { id: { in: rows.map(row => row.id) } },
    data: {
      payload: { purged: true, schemaVersion: 1 } satisfies Prisma.InputJsonObject,
      headers: Prisma.JsonNull,
      response: Prisma.JsonNull,
      lastError: null,
      payloadPurgedAt: now,
    },
  });
  return rows.length;
}

async function purgeCommunicationPayloads(before: Date, batchSize: number, now: Date) {
  const rows = await prisma.communicationAttempt.findMany({
    where: {
      payloadPurgedAt: null,
      createdAt: { lte: before },
      status: { in: TERMINAL_COMMUNICATION_STATUSES },
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  if (!rows.length) return 0;
  await prisma.communicationAttempt.updateMany({
    where: { id: { in: rows.map(row => row.id) } },
    data: {
      request: Prisma.JsonNull,
      response: Prisma.JsonNull,
      destination: null,
      origin: null,
      errorMessage: null,
      payloadPurgedAt: now,
    },
  });
  return rows.length;
}

async function purgeTranscripts(before: Date, batchSize: number, now: Date) {
  const rows = await prisma.callLog.findMany({
    where: { transcriptPurgedAt: null, createdAt: { lte: before }, transcript: { not: Prisma.JsonNull } },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  if (!rows.length) return 0;
  await prisma.callLog.updateMany({
    where: { id: { in: rows.map(row => row.id) } },
    data: {
      transcript: { retained: false, reason: 'retention_expired' },
      transcriptPurgedAt: now,
    },
  });
  return rows.length;
}

async function deleteTerminalOutbox(before: Date, batchSize: number) {
  const rows = await prisma.outboxEvent.findMany({
    where: {
      OR: [
        { status: 'processed', processedAt: { lte: before } },
        { status: 'dead_letter', createdAt: { lte: before } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  if (!rows.length) return 0;
  const result = await prisma.outboxEvent.deleteMany({
    where: { id: { in: rows.map(row => row.id) } },
  });
  return result.count;
}

async function deleteRegistrationRequests(before: Date, batchSize: number) {
  const rows = await prisma.organizationRegistrationRequest.findMany({
    where: { status: 'completed', completedAt: { lte: before } },
    orderBy: { completedAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  if (!rows.length) return 0;
  const result = await prisma.organizationRegistrationRequest.deleteMany({
    where: { id: { in: rows.map(row => row.id) } },
  });
  return result.count;
}

export async function runSensitiveDataRetention(batchSize = 500) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error('Retention batch size must be between 1 and 5000');
  }
  const config = getDataRetentionConfig();
  const now = new Date();
  const [webhooks, communications, transcripts, outbox, registrationRequests] = await Promise.all([
    purgeWebhookPayloads(cutoff(now, config.providerWebhookDays), batchSize, now),
    purgeCommunicationPayloads(cutoff(now, config.communicationPayloadDays), batchSize, now),
    purgeTranscripts(cutoff(now, config.transcriptDays), batchSize, now),
    deleteTerminalOutbox(cutoff(now, config.outboxDays), batchSize),
    deleteRegistrationRequests(cutoff(now, config.registrationRequestDays), batchSize),
  ]);
  return { webhooks, communications, transcripts, outbox, registrationRequests };
}
