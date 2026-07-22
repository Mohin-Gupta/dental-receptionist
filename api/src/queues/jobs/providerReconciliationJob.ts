import { Prisma } from '@prisma/client';
import twilio from 'twilio';
import { recordProviderCost, recordUsageEvent, USAGE_METRICS } from '../../billing/usage';
import { prisma } from '../../lib/prisma';
import {
  decryptProviderCredentials,
  vapiProviderOrganizationId,
} from '../../services/providerProvisioning';

const TWILIO_STATUS_RANK = {
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
} as const;

type TwilioMessageStatus = keyof typeof TWILIO_STATUS_RANK;

const TWILIO_TERMINAL_STATUSES = new Set<TwilioMessageStatus>([
  'partially_delivered',
  'undelivered',
  'failed',
  'canceled',
  'delivered',
  'read',
]);

const TWILIO_BILLABLE_STATUSES = new Set<TwilioMessageStatus>([
  'sent',
  ...TWILIO_TERMINAL_STATUSES,
]);

const TWILIO_RECONCILABLE_STATUSES = [
  'pending',
  'dispatching',
  'unknown',
  ...Object.keys(TWILIO_STATUS_RANK).filter(
    status => !TWILIO_TERMINAL_STATUSES.has(status as TwilioMessageStatus)
  ),
];

const VAPI_STATUS_RANK: Record<string, number> = {
  pending: 0,
  dispatching: 5,
  unknown: 5,
  accepted: 10,
  scheduled: 15,
  queued: 20,
  ringing: 30,
  'in-progress': 40,
  forwarding: 50,
  completed: 100,
  failed: 100,
  canceled: 100,
};

const VAPI_TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
const VAPI_RECONCILABLE_STATUSES = Object.keys(VAPI_STATUS_RANK).filter(
  status => !VAPI_TERMINAL_STATUSES.has(status)
);
const MAX_DATABASE_BIGINT = 9_223_372_036_854_775_807n;

const attemptInclude = Prisma.validator<Prisma.CommunicationAttemptInclude>()({
  providerResource: {
    include: { providerAccount: true },
  },
});

type ReconciliationAttempt = Prisma.CommunicationAttemptGetPayload<{
  include: typeof attemptInclude;
}>;

type ReconciliationProvider = 'twilio' | 'vapi';

interface ReconciliationConfig {
  batchSize: number;
  perTenantLimit: number;
  staleAfterMs: number;
  lookbackMs: number;
  providerTimeoutMs: number;
  providerRetries: number;
  maxRuntimeMs: number;
  providerResponseMaxBytes: number;
}

export interface ProviderReconciliationOptions {
  /** Maximum provider records processed in one invocation. */
  batchSize?: number;
  /** Fairness cap for a single organization in one invocation. */
  perTenantLimit?: number;
  /** Attempts newer than this are left for normal provider webhooks. */
  staleAfterMs?: number;
  /** Old attempts outside this window require an explicit/manual backfill. */
  lookbackMs?: number;
  /** Timeout for one provider request. */
  providerTimeoutMs?: number;
  /** Additional attempts for network, 408, 429, and 5xx failures. */
  providerRetries?: number;
  /** Soft wall-clock bound; an in-flight request may extend to its timeout. */
  maxRuntimeMs?: number;
  /** Maximum Vapi response body read into memory. */
  providerResponseMaxBytes?: number;
}

export interface ProviderReconciliationResult {
  selected: number;
  claimed: number;
  providerRecordsFetched: number;
  attemptsUpdated: number;
  usageEventsEnsured: number;
  providerCostsEnsured: number;
  usageMismatches: number;
  costMismatches: number;
  failures: number;
  skipped: number;
  runs: number;
  deadlineReached: boolean;
}

interface ReconciledAttemptResult {
  providerRecordFetched: boolean;
  attemptUpdated: boolean;
  usageEnsured: boolean;
  costEnsured: boolean;
  usageMismatch: boolean;
  costMismatch: boolean;
}

class SafeReconciliationError extends Error {
  constructor(
    readonly category: string,
    readonly retryable = false
  ) {
    super('Provider reconciliation failed');
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error('Provider reconciliation options are invalid');
  }
  return value;
}

function reconciliationConfig(options: ProviderReconciliationOptions): ReconciliationConfig {
  const batchSize = boundedInteger(options.batchSize, 20, 1, 100);
  return {
    batchSize,
    perTenantLimit: boundedInteger(options.perTenantLimit, Math.min(5, batchSize), 1, batchSize),
    staleAfterMs: boundedInteger(options.staleAfterMs, 5 * 60_000, 60_000, 24 * 60 * 60_000),
    lookbackMs: boundedInteger(options.lookbackMs, 30 * 24 * 60 * 60_000, 60 * 60_000, 365 * 24 * 60 * 60_000),
    providerTimeoutMs: boundedInteger(options.providerTimeoutMs, 5_000, 1_000, 15_000),
    providerRetries: boundedInteger(options.providerRetries, 1, 0, 3),
    maxRuntimeMs: boundedInteger(options.maxRuntimeMs, 45_000, 5_000, 5 * 60_000),
    providerResponseMaxBytes: boundedInteger(
      options.providerResponseMaxBytes,
      4 * 1024 * 1024,
      64 * 1024,
      16 * 1024 * 1024
    ),
  };
}

function asJsonObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Prisma.JsonObject
    : {};
}

function twilioAccountLocation(value: Prisma.JsonValue | null): {
  region?: string;
  edge?: string;
} {
  const config = asJsonObject(value);
  const region = nonEmptyString(config.region);
  const edge = nonEmptyString(config.edge);
  const safe = (candidate: string | null) =>
    candidate && /^[a-z0-9-]{1,32}$/.test(candidate) ? candidate : undefined;
  return { region: safe(region), edge: safe(edge) };
}

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) ? status : null;
}

function classifyProviderError(error: unknown): SafeReconciliationError {
  if (error instanceof SafeReconciliationError) return error;
  const status = providerErrorStatus(error);
  if (status === 401 || status === 403) {
    return new SafeReconciliationError('credentials_rejected');
  }
  if (status === 404) return new SafeReconciliationError('provider_record_not_found');
  if (status === 408 || status === 429 || (status !== null && status >= 500)) {
    return new SafeReconciliationError('provider_temporarily_unavailable', true);
  }
  if (status !== null) return new SafeReconciliationError('provider_request_rejected');
  return new SafeReconciliationError('provider_network_error', true);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withProviderRetry<T>(
  operation: () => Promise<T>,
  config: ReconciliationConfig,
  deadlineAt: number
): Promise<T> {
  let lastError: SafeReconciliationError | null = null;
  for (let attempt = 0; attempt <= config.providerRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = classifyProviderError(error);
      if (!lastError.retryable || attempt === config.providerRetries) throw lastError;
      const backoffMs = Math.min(1_000, 200 * (2 ** attempt)) + Math.floor(Math.random() * 100);
      if (Date.now() + backoffMs + config.providerTimeoutMs > deadlineAt) throw lastError;
      await delay(backoffMs);
    }
  }
  throw lastError ?? new SafeReconciliationError('provider_request_failed');
}

function normalizeVapiStatus(value: unknown, endedAt: Date | null): string | null {
  const raw = nonEmptyString(value)?.toLowerCase().replace(/_/g, '-');
  if (raw === 'cancelled') return 'canceled';
  if (raw === 'failed' || raw === 'canceled' || raw === 'completed') return raw;
  if (endedAt || raw === 'ended' || raw === 'complete') return 'completed';
  return raw && raw in VAPI_STATUS_RANK ? raw : null;
}

/** Pure transition helper used by reconciliation and suitable for focused tests. */
export function nextTwilioReconciledStatus(
  current: string,
  incoming: TwilioMessageStatus
): string {
  if (TWILIO_TERMINAL_STATUSES.has(current as TwilioMessageStatus)) {
    if (current === incoming) return current;
    return current === 'delivered' && incoming === 'read' ? incoming : current;
  }
  const currentRank = TWILIO_STATUS_RANK[current as TwilioMessageStatus] ?? 0;
  return TWILIO_STATUS_RANK[incoming] >= currentRank ? incoming : current;
}

/** Pure transition helper used by reconciliation and suitable for focused tests. */
export function nextVapiReconciledStatus(current: string, incoming: string | null): string {
  if (!incoming) return current;
  const rawCurrent = current.toLowerCase().replace(/_/g, '-');
  const normalizedCurrent = rawCurrent === 'cancelled' ? 'canceled' : rawCurrent;
  if (VAPI_TERMINAL_STATUSES.has(normalizedCurrent)) return current;
  const currentRank = VAPI_STATUS_RANK[normalizedCurrent] ?? 0;
  const incomingRank = VAPI_STATUS_RANK[incoming];
  return incomingRank !== undefined && incomingRank >= currentRank ? incoming : current;
}

function validateAttemptAttribution(attempt: ReconciliationAttempt): void {
  const resource = attempt.providerResource;
  const account = resource?.providerAccount;
  const commonMismatch =
    !resource ||
    !account ||
    resource.id !== attempt.providerResourceId ||
    resource.organizationId !== attempt.organizationId ||
    resource.provider !== attempt.provider ||
    account.id !== resource.providerAccountId ||
    account.organizationId !== attempt.organizationId ||
    account.provider !== attempt.provider ||
    (resource.clinicId !== null && resource.clinicId !== attempt.clinicId);
  if (commonMismatch) throw new SafeReconciliationError('tenant_attribution_invalid');

  if (
    (attempt.provider === 'twilio' && !['phone_number', 'messaging_service'].includes(resource.resourceType)) ||
    (attempt.provider === 'vapi' && resource.resourceType !== 'phone_number')
  ) {
    throw new SafeReconciliationError('provider_resource_invalid');
  }
}

function messageStatus(value: unknown): TwilioMessageStatus | null {
  return typeof value === 'string' && value in TWILIO_STATUS_RANK
    ? value as TwilioMessageStatus
    : null;
}

function parseTwilioSegments(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const segments = Number.parseInt(value, 10);
  return Number.isSafeInteger(segments) && segments >= 0 && segments <= 10_000
    ? segments
    : null;
}

function twilioPriceMicros(value: unknown): bigint | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const price = new Prisma.Decimal(value);
    if (!price.isFinite()) return null;
    const micros = BigInt(price.abs().mul(1_000_000).toFixed(0));
    return micros <= MAX_DATABASE_BIGINT ? micros : null;
  } catch {
    return null;
  }
}

function usdCostMicros(value: number): bigint | null {
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros < 0) return null;
  const amount = BigInt(micros);
  return amount <= MAX_DATABASE_BIGINT ? amount : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function vapiDurationSeconds(payload: Record<string, unknown>): number | null {
  const direct = finiteNonNegative(payload.durationSeconds);
  if (direct !== null && direct <= 86_400) return Math.round(direct);

  const durationMs = finiteNonNegative(payload.durationMs);
  if (durationMs !== null && durationMs <= 86_400_000) return Math.round(durationMs / 1_000);

  const duration = finiteNonNegative(payload.duration);
  if (duration !== null) {
    const seconds = duration > 10_000 ? duration / 1_000 : duration;
    if (seconds <= 86_400) return Math.round(seconds);
  }

  const startedAt = validDate(payload.startedAt);
  const endedAt = validDate(payload.endedAt);
  if (startedAt && endedAt) {
    const seconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1_000);
    if (seconds >= 0 && seconds <= 86_400) return seconds;
  }
  return null;
}

function vapiCostUsd(payload: Record<string, unknown>): number | null {
  const direct = finiteNonNegative(payload.cost);
  if (direct !== null) return direct;

  const breakdown = payload.costBreakdown;
  if (breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)) {
    const total = finiteNonNegative((breakdown as Record<string, unknown>).total);
    if (total !== null) return total;
  }

  if (Array.isArray(payload.costs)) {
    const components = payload.costs.map(item =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? finiteNonNegative((item as Record<string, unknown>).cost)
        : null
    );
    if (components.length > 0 && components.every(value => value !== null)) {
      return (components as number[]).reduce((total, value) => total + value, 0);
    }
  }
  return null;
}

function vapiMeteredUsage(payload: Record<string, unknown>) {
  const breakdown = payload.costBreakdown;
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    return [] as Array<{ metric: string; quantity: number; unit: string }>;
  }
  const record = breakdown as Record<string, unknown>;
  const fields = [
    [USAGE_METRICS.VAPI_LLM_PROMPT_TOKENS, record.llmPromptTokens, 'token'],
    [USAGE_METRICS.VAPI_LLM_CACHED_PROMPT_TOKENS, record.llmCachedPromptTokens, 'token'],
    [USAGE_METRICS.VAPI_LLM_COMPLETION_TOKENS, record.llmCompletionTokens, 'token'],
    [USAGE_METRICS.VAPI_TTS_CHARACTERS, record.ttsCharacters, 'character'],
  ] as const;
  return fields.flatMap(([metric, value, unit]) => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? [{ metric, quantity: value, unit }]
      : []
  ));
}

async function readBoundedJsonObject(
  response: Response,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new SafeReconciliationError('provider_response_too_large');
  }

  if (!response.body) throw new SafeReconciliationError('provider_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new SafeReconciliationError('provider_response_too_large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new SafeReconciliationError('provider_response_invalid');
  }
}

async function findUsageEvent(
  organizationId: string,
  idempotencyKey: string
) {
  return prisma.usageEvent.findUnique({
    where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
  });
}

async function findProviderCost(provider: string, idempotencyKey: string) {
  return prisma.providerCostEntry.findUnique({
    where: { provider_idempotencyKey: { provider, idempotencyKey } },
  });
}

function sameDecimal(left: Prisma.Decimal.Value, right: Prisma.Decimal.Value): boolean {
  return new Prisma.Decimal(left).equals(new Prisma.Decimal(right));
}

async function ensureUsage(input: {
  attempt: ReconciliationAttempt;
  metric: string;
  quantity: number;
  unit: string;
  source: string;
  externalEventId: string;
  idempotencyKey: string;
  occurredAt: Date;
}): Promise<{ id: string; ensured: boolean; mismatch: boolean }> {
  const existing = await findUsageEvent(input.attempt.organizationId, input.idempotencyKey);
  if (existing) {
    const attributionMatches =
      existing.organizationId === input.attempt.organizationId &&
      existing.communicationAttemptId === input.attempt.id &&
      existing.metric === input.metric &&
      existing.externalEventId === input.externalEventId;
    if (!attributionMatches) throw new SafeReconciliationError('usage_attribution_invalid');
    const total = await prisma.usageEvent.aggregate({
      where: {
        organizationId: input.attempt.organizationId,
        OR: [{ id: existing.id }, { correctionOfId: existing.id }],
      },
      _sum: { quantity: true },
    });
    const currentQuantity = total._sum.quantity ?? new Prisma.Decimal(0);
    const expectedQuantity = new Prisma.Decimal(input.quantity);
    if (currentQuantity.equals(expectedQuantity)) {
      return { id: existing.id, ensured: false, mismatch: false };
    }
    const delta = expectedQuantity.minus(currentQuantity);
    await recordUsageEvent({
      organizationId: input.attempt.organizationId,
      clinicId: input.attempt.clinicId,
      providerResourceId: input.attempt.providerResourceId,
      communicationAttemptId: input.attempt.id,
      correctionOfId: existing.id,
      metric: input.metric,
      quantity: delta,
      unit: input.unit,
      source: `${input.source}_correction`,
      externalEventId: input.externalEventId,
      idempotencyKey: `${input.idempotencyKey}:reconciled:${expectedQuantity.toFixed()}`,
      occurredAt: input.occurredAt,
      metadata: { correctedBy: 'provider_reconciliation' },
    });
    return { id: existing.id, ensured: true, mismatch: true };
  }

  const event = await recordUsageEvent({
    organizationId: input.attempt.organizationId,
    clinicId: input.attempt.clinicId,
    providerResourceId: input.attempt.providerResourceId,
    communicationAttemptId: input.attempt.id,
    metric: input.metric,
    quantity: input.quantity,
    unit: input.unit,
    source: input.source,
    externalEventId: input.externalEventId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    metadata: { direction: input.attempt.direction },
  });
  if (
    event.organizationId !== input.attempt.organizationId ||
    event.communicationAttemptId !== input.attempt.id ||
    event.metric !== input.metric ||
    event.externalEventId !== input.externalEventId
  ) {
    throw new SafeReconciliationError('usage_attribution_invalid');
  }
  return { id: event.id, ensured: true, mismatch: !sameDecimal(event.quantity, input.quantity) };
}

async function ensureCost(input: {
  attempt: ReconciliationAttempt;
  reconciliationRunId: string;
  provider: ReconciliationProvider;
  costType: string;
  quantity?: number;
  unit?: string;
  amountMicros: bigint;
  currency: string;
  externalEventId: string;
  idempotencyKey: string;
  occurredAt: Date;
  usageEventId?: string | null;
}): Promise<{ ensured: boolean; mismatch: boolean }> {
  const existing = await findProviderCost(input.provider, input.idempotencyKey);
  if (existing) {
    const attributionMatches =
      existing.organizationId === input.attempt.organizationId &&
      existing.communicationAttemptId === input.attempt.id &&
      existing.provider === input.provider &&
      existing.costType === input.costType &&
      existing.externalEventId === input.externalEventId;
    if (!attributionMatches) throw new SafeReconciliationError('cost_attribution_invalid');
    if (existing.currency !== input.currency) {
      throw new SafeReconciliationError('cost_currency_mismatch');
    }
    const total = await prisma.providerCostEntry.aggregate({
      where: {
        organizationId: input.attempt.organizationId,
        OR: [{ id: existing.id }, { correctionOfId: existing.id }],
      },
      _sum: { amountMicros: true },
    });
    const currentAmount = total._sum.amountMicros ?? 0n;
    if (currentAmount === input.amountMicros) {
      return { ensured: false, mismatch: false };
    }
    await recordProviderCost({
      organizationId: input.attempt.organizationId,
      clinicId: input.attempt.clinicId,
      providerResourceId: input.attempt.providerResourceId,
      communicationAttemptId: input.attempt.id,
      usageEventId: input.usageEventId ?? null,
      reconciliationRunId: input.reconciliationRunId,
      correctionOfId: existing.id,
      provider: input.provider,
      costType: input.costType,
      amountMicros: input.amountMicros - currentAmount,
      currency: input.currency,
      externalEventId: input.externalEventId,
      idempotencyKey: `${input.idempotencyKey}:reconciled:${input.amountMicros.toString()}`,
      occurredAt: input.occurredAt,
      metadata: { correctedBy: 'provider_reconciliation' },
    });
    return { ensured: true, mismatch: true };
  }

  const cost = await recordProviderCost({
    organizationId: input.attempt.organizationId,
    clinicId: input.attempt.clinicId,
    providerResourceId: input.attempt.providerResourceId,
    communicationAttemptId: input.attempt.id,
    usageEventId: input.usageEventId ?? null,
    reconciliationRunId: input.reconciliationRunId,
    provider: input.provider,
    costType: input.costType,
    quantity: input.quantity,
    unit: input.unit,
    amountMicros: input.amountMicros,
    currency: input.currency,
    externalEventId: input.externalEventId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    metadata: { reportedBy: 'provider_reconciliation' },
  });
  if (
    cost.organizationId !== input.attempt.organizationId ||
    cost.communicationAttemptId !== input.attempt.id ||
    cost.provider !== input.provider ||
    cost.costType !== input.costType ||
    cost.externalEventId !== input.externalEventId
  ) {
    throw new SafeReconciliationError('cost_attribution_invalid');
  }
  return {
    ensured: true,
    mismatch: cost.amountMicros !== input.amountMicros || cost.currency !== input.currency,
  };
}

async function reconcileTwilioAttempt(
  attempt: ReconciliationAttempt,
  claimedAt: Date,
  reconciliationRunId: string,
  config: ReconciliationConfig,
  deadlineAt: number
): Promise<ReconciledAttemptResult> {
  const resource = attempt.providerResource!;
  let credentials: ReturnType<typeof decryptProviderCredentials>;
  try {
    credentials = decryptProviderCredentials(resource.providerAccount);
  } catch {
    throw new SafeReconciliationError('provider_credentials_invalid');
  }
  if (!('accountSid' in credentials)) {
    throw new SafeReconciliationError('provider_credentials_invalid');
  }
  if (!attempt.externalId) throw new SafeReconciliationError('external_id_missing');

  const httpClient = new twilio.RequestClient({
    timeout: config.providerTimeoutMs,
    autoRetry: false,
  });
  const client = twilio(credentials.accountSid, credentials.authToken, {
    accountSid: credentials.accountSid,
    autoRetry: false,
    httpClient,
    ...twilioAccountLocation(resource.providerAccount.config),
  });
  const message = await withProviderRetry(
    () => client.messages(attempt.externalId!).fetch(),
    config,
    deadlineAt
  );
  if (message.sid !== attempt.externalId || message.accountSid !== credentials.accountSid) {
    throw new SafeReconciliationError('provider_record_attribution_invalid');
  }
  if (typeof message.direction === 'string' && !message.direction.startsWith('outbound')) {
    throw new SafeReconciliationError('provider_record_direction_invalid');
  }
  if (
    resource.resourceType === 'messaging_service' &&
    message.messagingServiceSid !== resource.externalId
  ) {
    throw new SafeReconciliationError('provider_record_resource_invalid');
  }
  if (resource.resourceType === 'phone_number' && message.from !== resource.externalId) {
    throw new SafeReconciliationError('provider_record_resource_invalid');
  }

  const incomingStatus = messageStatus(message.status);
  const effectiveStatus = incomingStatus
    ? nextTwilioReconciledStatus(attempt.status, incomingStatus)
    : attempt.status;
  const segments = parseTwilioSegments(message.numSegments);
  const occurredAt = message.dateUpdated instanceof Date ? message.dateUpdated : new Date();
  const terminal = incomingStatus ? TWILIO_TERMINAL_STATUSES.has(incomingStatus) : false;
  const effectiveFailed = ['failed', 'undelivered', 'canceled'].includes(effectiveStatus);
  const statusAccepted = incomingStatus !== null && effectiveStatus === incomingStatus;

  const updated = await prisma.communicationAttempt.updateMany({
    where: {
      id: attempt.id,
      organizationId: attempt.organizationId,
      providerResourceId: resource.id,
      updatedAt: claimedAt,
    },
    data: {
      status: effectiveStatus,
      ...(segments !== null ? { segmentCount: segments } : {}),
      ...(statusAccepted ? { errorCode: message.errorCode ? String(message.errorCode) : null } : {}),
      ...(!effectiveFailed ? { errorMessage: null } : {}),
      ...(terminal && !attempt.endedAt ? { endedAt: occurredAt } : {}),
      response: {
        ...asJsonObject(attempt.response),
        sid: message.sid,
        status: effectiveStatus,
        segments: segments ?? attempt.segmentCount ?? null,
        priceUnit: message.priceUnit || null,
        reconciledFrom: 'message_resource',
      },
    },
  });

  let usageEventId: string | null = null;
  let usageEnsured = false;
  let usageMismatch = false;
  const billable = incomingStatus ? TWILIO_BILLABLE_STATUSES.has(incomingStatus) : false;
  if (billable && segments !== null && segments > 0) {
    const usage = await ensureUsage({
      attempt,
      metric: USAGE_METRICS.SMS_SEGMENTS,
      quantity: segments,
      unit: 'segment',
      source: 'twilio_message_resource',
      externalEventId: message.sid,
      idempotencyKey: `twilio:${message.sid}:sms-segments`,
      occurredAt,
    });
    usageEventId = usage.id;
    usageEnsured = usage.ensured;
    usageMismatch = usage.mismatch;
  }

  let costEnsured = false;
  let costMismatch = false;
  const amountMicros = twilioPriceMicros(message.price);
  const currency = nonEmptyString(message.priceUnit)?.toUpperCase() ?? null;
  if (billable && amountMicros !== null && currency) {
    const cost = await ensureCost({
      attempt,
      reconciliationRunId,
      provider: 'twilio',
      costType: 'sms_message',
      quantity: segments && segments > 0 ? segments : undefined,
      unit: segments && segments > 0 ? 'segment' : undefined,
      amountMicros,
      currency,
      externalEventId: message.sid,
      idempotencyKey: `${message.sid}:reported-cost`,
      occurredAt,
      usageEventId,
    });
    costEnsured = cost.ensured;
    costMismatch = cost.mismatch;
  }

  if (terminal && (segments === 0 || (segments !== null && amountMicros !== null && currency))) {
    await prisma.communicationAttempt.updateMany({
      where: { id: attempt.id, organizationId: attempt.organizationId },
      data: { usageFinalizedAt: new Date() },
    });
  }

  return {
    providerRecordFetched: true,
    attemptUpdated: updated.count === 1,
    usageEnsured,
    costEnsured,
    usageMismatch,
    costMismatch,
  };
}

async function fetchVapiCall(
  callId: string,
  apiKey: string,
  config: ReconciliationConfig,
  deadlineAt: number
): Promise<Record<string, unknown>> {
  return withProviderRetry(async () => {
    let response: Response;
    try {
      response = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(config.providerTimeoutMs),
      });
    } catch {
      throw new SafeReconciliationError('provider_network_error', true);
    }

    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      if (status === 401 || status === 403) {
        throw new SafeReconciliationError('credentials_rejected');
      }
      if (status === 404) throw new SafeReconciliationError('provider_record_not_found');
      if (status === 408 || status === 429 || status >= 500) {
        throw new SafeReconciliationError('provider_temporarily_unavailable', true);
      }
      throw new SafeReconciliationError('provider_request_rejected');
    }
    return readBoundedJsonObject(response, config.providerResponseMaxBytes);
  }, config, deadlineAt);
}

function vapiPhoneNumberId(payload: Record<string, unknown>): string | null {
  const direct = nonEmptyString(payload.phoneNumberId);
  if (direct) return direct;
  const phoneNumber = payload.phoneNumber;
  return phoneNumber && typeof phoneNumber === 'object' && !Array.isArray(phoneNumber)
    ? nonEmptyString((phoneNumber as Record<string, unknown>).id)
    : null;
}

async function reconcileVapiAttempt(
  attempt: ReconciliationAttempt,
  claimedAt: Date,
  reconciliationRunId: string,
  config: ReconciliationConfig,
  deadlineAt: number
): Promise<ReconciledAttemptResult> {
  const resource = attempt.providerResource!;
  let credentials: ReturnType<typeof decryptProviderCredentials>;
  try {
    credentials = decryptProviderCredentials(resource.providerAccount);
  } catch {
    throw new SafeReconciliationError('provider_credentials_invalid');
  }
  if (!('apiKey' in credentials)) {
    throw new SafeReconciliationError('provider_credentials_invalid');
  }
  if (!attempt.externalId) throw new SafeReconciliationError('external_id_missing');

  const call = await fetchVapiCall(
    attempt.externalId,
    credentials.apiKey,
    config,
    deadlineAt
  );
  if (nonEmptyString(call.id) !== attempt.externalId) {
    throw new SafeReconciliationError('provider_record_attribution_invalid');
  }
  const providerOrganizationId = nonEmptyString(call.orgId);
  const expectedProviderOrganizationId = vapiProviderOrganizationId(
    resource.providerAccount
  );
  if (
    expectedProviderOrganizationId &&
    providerOrganizationId !== expectedProviderOrganizationId
  ) {
    throw new SafeReconciliationError('provider_record_account_invalid');
  }
  const phoneNumberId = vapiPhoneNumberId(call);
  if (phoneNumberId && phoneNumberId !== resource.externalId) {
    throw new SafeReconciliationError('provider_record_resource_invalid');
  }
  const providerType = nonEmptyString(call.type);
  if (
    (providerType === 'outboundPhoneCall' && attempt.direction !== 'outbound') ||
    (providerType === 'inboundPhoneCall' && attempt.direction !== 'inbound')
  ) {
    throw new SafeReconciliationError('provider_record_direction_invalid');
  }

  const endedAt = validDate(call.endedAt);
  const startedAt = validDate(call.startedAt);
  const incomingStatus = normalizeVapiStatus(call.status, endedAt);
  const effectiveStatus = nextVapiReconciledStatus(attempt.status, incomingStatus);
  const final = incomingStatus ? VAPI_TERMINAL_STATUSES.has(incomingStatus) : false;
  const durationSeconds = final ? vapiDurationSeconds(call) : null;
  const endedReason = nonEmptyString(call.endedReason);
  const safeEndedReason = endedReason && /^[A-Za-z0-9._:-]{1,200}$/.test(endedReason)
    ? endedReason
    : null;
  const occurredAt = endedAt ?? new Date();

  const updated = await prisma.communicationAttempt.updateMany({
    where: {
      id: attempt.id,
      organizationId: attempt.organizationId,
      providerResourceId: resource.id,
      updatedAt: claimedAt,
    },
    data: {
      status: effectiveStatus,
      ...(durationSeconds !== null ? { durationSeconds } : {}),
      ...(startedAt && !attempt.startedAt ? { startedAt } : {}),
      ...(endedAt && !attempt.endedAt ? { endedAt } : {}),
      ...(effectiveStatus === 'failed' ? {} : { errorMessage: null }),
      response: {
        ...asJsonObject(attempt.response),
        id: attempt.externalId,
        status: effectiveStatus,
        ...(safeEndedReason ? { endedReason: safeEndedReason } : {}),
        reconciledFrom: 'call_resource',
      },
    },
  });

  let usageEventId: string | null = null;
  let usageEnsured = false;
  let usageMismatch = false;
  if (final && durationSeconds !== null && durationSeconds > 0) {
    const usage = await ensureUsage({
      attempt,
      metric: USAGE_METRICS.VOICE_SECONDS,
      quantity: durationSeconds,
      unit: 'second',
      source: 'vapi_call_resource',
      externalEventId: attempt.externalId,
      idempotencyKey: `vapi:${attempt.externalId}:voice-seconds`,
      occurredAt,
    });
    usageEventId = usage.id;
    usageEnsured = usage.ensured;
    usageMismatch = usage.mismatch;
  }
  if (final) {
    for (const metered of vapiMeteredUsage(call)) {
      const usage = await ensureUsage({
        attempt,
        metric: metered.metric,
        quantity: metered.quantity,
        unit: metered.unit,
        source: 'vapi_call_resource',
        externalEventId: attempt.externalId,
        idempotencyKey: `vapi:${attempt.externalId}:${metered.metric}`,
        occurredAt,
      });
      usageEnsured = usageEnsured || usage.ensured;
      usageMismatch = usageMismatch || usage.mismatch;
    }
  }

  let costEnsured = false;
  let costMismatch = false;
  const costUsd = final ? vapiCostUsd(call) : null;
  const amountMicros = costUsd === null ? null : usdCostMicros(costUsd);
  if (amountMicros !== null) {
    const cost = await ensureCost({
      attempt,
      reconciliationRunId,
      provider: 'vapi',
      costType: 'voice_call',
      quantity: durationSeconds && durationSeconds > 0 ? durationSeconds : undefined,
      unit: durationSeconds && durationSeconds > 0 ? 'second' : undefined,
      amountMicros,
      currency: 'USD',
      externalEventId: attempt.externalId,
      idempotencyKey: `${attempt.externalId}:reported-cost`,
      occurredAt,
      usageEventId,
    });
    costEnsured = cost.ensured;
    costMismatch = cost.mismatch;
  }

  // A final provider record closes the retail event stream. Vendor cost and a
  // missing duration remain independent reconciliation concerns.
  if (final) {
    await prisma.communicationAttempt.updateMany({
      where: { id: attempt.id, organizationId: attempt.organizationId },
      data: { usageFinalizedAt: new Date() },
    });
  }

  return {
    providerRecordFetched: true,
    attemptUpdated: updated.count === 1,
    usageEnsured,
    costEnsured,
    usageMismatch,
    costMismatch,
  };
}

function candidateWhere(now: Date, config: ReconciliationConfig): Prisma.CommunicationAttemptWhereInput {
  const staleBefore = new Date(now.getTime() - config.staleAfterMs);
  const createdAfter = new Date(now.getTime() - config.lookbackMs);
  return {
    updatedAt: { lte: staleBefore },
    createdAt: { gte: createdAfter },
    externalId: { not: null },
    providerResourceId: { not: null },
    OR: [
      {
        provider: 'twilio',
        channel: 'sms',
        direction: 'outbound',
        OR: [
          { usageFinalizedAt: null },
          { status: { in: TWILIO_RECONCILABLE_STATUSES } },
          { segmentCount: null },
          {
            segmentCount: { gt: 0 },
            usageEvents: { none: { metric: USAGE_METRICS.SMS_SEGMENTS } },
          },
          {
            providerCostEntries: {
              none: { provider: 'twilio', costType: 'sms_message' },
            },
          },
        ],
      },
      {
        provider: 'vapi',
        channel: 'voice',
        OR: [
          { usageFinalizedAt: null },
          { status: { in: VAPI_RECONCILABLE_STATUSES } },
          { durationSeconds: null },
          {
            durationSeconds: { gt: 0 },
            usageEvents: { none: { metric: USAGE_METRICS.VOICE_SECONDS } },
          },
          {
            providerCostEntries: {
              none: { provider: 'vapi', costType: 'voice_call' },
            },
          },
        ],
      },
    ],
  };
}

function selectFairBatch(
  candidates: ReconciliationAttempt[],
  config: ReconciliationConfig
): ReconciliationAttempt[] {
  const tenantCounts = new Map<string, number>();
  const selected: ReconciliationAttempt[] = [];
  for (const candidate of candidates) {
    const count = tenantCounts.get(candidate.organizationId) ?? 0;
    if (count >= config.perTenantLimit) continue;
    tenantCounts.set(candidate.organizationId, count + 1);
    selected.push(candidate);
    if (selected.length >= config.batchSize) break;
  }
  return selected;
}

function groupCandidates(candidates: ReconciliationAttempt[]) {
  const groups = new Map<string, ReconciliationAttempt[]>();
  for (const candidate of candidates) {
    const key = `${candidate.organizationId}:${candidate.provider}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function emptyResult(selected: number): ProviderReconciliationResult {
  return {
    selected,
    claimed: 0,
    providerRecordsFetched: 0,
    attemptsUpdated: 0,
    usageEventsEnsured: 0,
    providerCostsEnsured: 0,
    usageMismatches: 0,
    costMismatches: 0,
    failures: 0,
    skipped: 0,
    runs: 0,
    deadlineReached: false,
  };
}

/**
 * Bounded, tenant-safe provider reconciliation worker entry point.
 *
 * This function only performs provider reads and local append/update writes. It
 * never invokes a provider create/send endpoint and therefore never resends a
 * patient communication. The caller owns scheduling and non-overlap policy.
 */
export async function reconcileStaleProviderAttempts(
  options: ProviderReconciliationOptions = {}
): Promise<ProviderReconciliationResult> {
  const config = reconciliationConfig(options);
  const startedAt = new Date();
  const deadlineAt = startedAt.getTime() + config.maxRuntimeMs;

  try {
    const scanLimit = Math.min(500, config.batchSize * 10);
    const candidates = await prisma.communicationAttempt.findMany({
      where: candidateWhere(startedAt, config),
      include: attemptInclude,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: scanLimit,
    });
    const selected = selectFairBatch(candidates, config);
    const result = emptyResult(selected.length);

    for (const group of groupCandidates(selected)) {
      if (Date.now() >= deadlineAt) {
        result.deadlineReached = true;
        break;
      }
      const first = group[0];
      if (!first || !['twilio', 'vapi'].includes(first.provider)) continue;
      const provider = first.provider as ReconciliationProvider;
      const run = await prisma.reconciliationRun.create({
        data: {
          organizationId: first.organizationId,
          provider,
          scope: 'communication_attempts',
          windowStart: group.reduce(
            (earliest, attempt) => attempt.createdAt < earliest ? attempt.createdAt : earliest,
            first.createdAt
          ),
          windowEnd: startedAt,
          status: 'running',
          localEventCount: group.length,
          startedAt: new Date(),
          summary: { selected: group.length },
        },
      });
      result.runs += 1;

      const runCounts = {
        selected: group.length,
        claimed: 0,
        fetched: 0,
        updated: 0,
        usageEnsured: 0,
        costsEnsured: 0,
        usageMismatches: 0,
        costMismatches: 0,
        failures: 0,
        skipped: 0,
      };
      const failureCategories: Record<string, number> = {};

      for (const attempt of group) {
        if (Date.now() >= deadlineAt) {
          result.deadlineReached = true;
          break;
        }
        const claimedAt = new Date();
        const claim = await prisma.communicationAttempt.updateMany({
          where: {
            id: attempt.id,
            organizationId: attempt.organizationId,
            provider: attempt.provider,
            providerResourceId: attempt.providerResourceId,
            updatedAt: attempt.updatedAt,
          },
          // A no-content compare-and-set claim also gives failed provider reads
          // a durable stale-window backoff without overwriting webhook data.
          data: { updatedAt: claimedAt },
        });
        if (claim.count !== 1) {
          runCounts.skipped += 1;
          result.skipped += 1;
          continue;
        }
        runCounts.claimed += 1;
        result.claimed += 1;

        try {
          validateAttemptAttribution(attempt);
          const reconciled = provider === 'twilio'
            ? await reconcileTwilioAttempt(attempt, claimedAt, run.id, config, deadlineAt)
            : await reconcileVapiAttempt(attempt, claimedAt, run.id, config, deadlineAt);
          if (reconciled.providerRecordFetched) {
            runCounts.fetched += 1;
            result.providerRecordsFetched += 1;
          }
          if (reconciled.attemptUpdated) {
            runCounts.updated += 1;
            result.attemptsUpdated += 1;
          }
          if (reconciled.usageEnsured) {
            runCounts.usageEnsured += 1;
            result.usageEventsEnsured += 1;
          }
          if (reconciled.costEnsured) {
            runCounts.costsEnsured += 1;
            result.providerCostsEnsured += 1;
          }
          if (reconciled.usageMismatch) {
            runCounts.usageMismatches += 1;
            result.usageMismatches += 1;
          }
          if (reconciled.costMismatch) {
            runCounts.costMismatches += 1;
            result.costMismatches += 1;
          }
        } catch (error) {
          const safe = error instanceof SafeReconciliationError
            ? error
            : new SafeReconciliationError('local_reconciliation_error');
          failureCategories[safe.category] = (failureCategories[safe.category] ?? 0) + 1;
          runCounts.failures += 1;
          result.failures += 1;
        }
      }

      await prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: runCounts.failures > 0 ? 'completed_with_errors' : 'completed',
          localEventCount: runCounts.claimed,
          providerEventCount: runCounts.fetched,
          summary: {
            ...runCounts,
            failureCategories,
            deadlineReached: result.deadlineReached,
          },
          error: runCounts.failures > 0
            ? `${runCounts.failures} communication reconciliation item(s) failed`
            : null,
          completedAt: new Date(),
        },
      });
    }

    return result;
  } catch {
    // The worker wrapper logs task messages. Keep this exception generic so a
    // provider/Prisma error can never place PHI, credentials, or payloads there.
    throw new Error('Provider reconciliation task failed');
  }
}
