import { redis } from '../lib/redis';

export interface SlotState {
  date: string;
  slots: Array<{
    start: string;
    label: string;
  }>;
}

export interface ConfirmedDetailsState {
  patientName: string;
  patientPhone: string;
  date: string;
  time: string;
  reason: string;
}

export interface CallerVerificationState {
  patientId: string;
  codeDigest: string;
  expiresAt: string;
  attempts: number;
  verifiedAt: string | null;
}

export interface TenantCallScope {
  callId: string;
  clinicId: string;
}

type StateField = 'slots' | 'confirmedDetails' | 'patientName' | 'callerVerification';

const DEFAULT_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_COMMAND_TIMEOUT_MS = 1_500;

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

const stateTtlSeconds = boundedPositiveInteger(
  process.env.CALL_STATE_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  5 * 60,
  24 * 60 * 60
);

const commandTimeoutMs = boundedPositiveInteger(
  process.env.CALL_STATE_REDIS_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  100,
  10_000
);

export class CallStateUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Call state is unavailable during ${operation}`);
    this.name = 'CallStateUnavailableError';
    this.cause = options?.cause;
  }
}

function encodeKeyPart(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required for call state`);
  if (trimmed.length > 255) throw new Error(`${label} is too long for call state`);
  return encodeURIComponent(trimmed);
}

function stateKey(scope: TenantCallScope): string {
  const callId = encodeKeyPart(scope.callId, 'callId');
  const clinicId = encodeKeyPart(scope.clinicId, 'clinicId');
  return `tenant:clinic:${clinicId}:call:${callId}:state`;
}

async function withCommandTimeout<T>(operation: string, command: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      command,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CallStateUnavailableError(operation)),
          commandTimeoutMs
        );
        timeout.unref();
      }),
    ]);
  } catch (error) {
    if (error instanceof CallStateUnavailableError) throw error;
    throw new CallStateUnavailableError(operation, { cause: error });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readField(scope: TenantCallScope, field: StateField): Promise<string | null> {
  return withCommandTimeout(
    `reading ${field}`,
    redis.hget(stateKey(scope), field)
  );
}

async function writeField(
  scope: TenantCallScope,
  field: StateField,
  value: string
): Promise<void> {
  const key = stateKey(scope);
  const results = await withCommandTimeout(
    `writing ${field}`,
    redis.multi().hset(key, field, value).expire(key, stateTtlSeconds).exec()
  );

  if (!results || results.some(([error]) => error !== null)) {
    throw new CallStateUnavailableError(`writing ${field}`);
  }
}

async function deleteField(scope: TenantCallScope, field: StateField): Promise<void> {
  await withCommandTimeout(`deleting ${field}`, redis.hdel(stateKey(scope), field));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parsePatientName(value: string | null): string | null {
  if (value === null) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return isString(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function parseSlotState(value: string | null): SlotState | null {
  if (value === null) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    if (!isString(candidate.date) || !Array.isArray(candidate.slots)) return null;

    const slots = candidate.slots;
    if (!slots.every(slot => {
      if (!slot || typeof slot !== 'object') return false;
      const record = slot as Record<string, unknown>;
      return isString(record.start) && isString(record.label);
    })) return null;

    return {
      date: candidate.date,
      slots: slots.map(slot => {
        const record = slot as Record<string, unknown>;
        return { start: record.start as string, label: record.label as string };
      }),
    };
  } catch {
    return null;
  }
}

function parseConfirmedDetails(value: string | null): ConfirmedDetailsState | null {
  if (value === null) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    if (
      !isString(candidate.patientName) ||
      !isString(candidate.patientPhone) ||
      !isString(candidate.date) ||
      !isString(candidate.time) ||
      !isString(candidate.reason)
    ) return null;

    return {
      patientName: candidate.patientName,
      patientPhone: candidate.patientPhone,
      date: candidate.date,
      time: candidate.time,
      reason: candidate.reason,
    };
  } catch {
    return null;
  }
}

function parseCallerVerification(value: string | null): CallerVerificationState | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      !isString(candidate.patientId) ||
      !isString(candidate.codeDigest) ||
      !isString(candidate.expiresAt) ||
      typeof candidate.attempts !== 'number' ||
      !Number.isInteger(candidate.attempts) ||
      candidate.attempts < 0 ||
      (candidate.verifiedAt !== null && !isString(candidate.verifiedAt))
    ) return null;
    return {
      patientId: candidate.patientId,
      codeDigest: candidate.codeDigest,
      expiresAt: candidate.expiresAt,
      attempts: candidate.attempts,
      verifiedAt: candidate.verifiedAt as string | null,
    };
  } catch {
    return null;
  }
}

export async function getSlotState(scope: TenantCallScope): Promise<SlotState | null> {
  return parseSlotState(await readField(scope, 'slots'));
}

export async function setSlotState(scope: TenantCallScope, value: SlotState): Promise<void> {
  await writeField(scope, 'slots', JSON.stringify(value));
}

export async function getConfirmedDetails(
  scope: TenantCallScope
): Promise<ConfirmedDetailsState | null> {
  return parseConfirmedDetails(await readField(scope, 'confirmedDetails'));
}

export async function setConfirmedDetails(
  scope: TenantCallScope,
  value: ConfirmedDetailsState
): Promise<void> {
  await writeField(scope, 'confirmedDetails', JSON.stringify(value));
}

export async function getPatientName(scope: TenantCallScope): Promise<string | null> {
  return parsePatientName(await readField(scope, 'patientName'));
}

export async function setPatientName(scope: TenantCallScope, value: string): Promise<void> {
  await writeField(scope, 'patientName', JSON.stringify(value));
}

export async function getCallerVerification(
  scope: TenantCallScope
): Promise<CallerVerificationState | null> {
  return parseCallerVerification(await readField(scope, 'callerVerification'));
}

export async function setCallerVerification(
  scope: TenantCallScope,
  value: CallerVerificationState
): Promise<void> {
  await writeField(scope, 'callerVerification', JSON.stringify(value));
}

export async function clearCallerVerification(scope: TenantCallScope): Promise<void> {
  await deleteField(scope, 'callerVerification');
}

const VERIFY_CALLER_CODE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, state = pcall(cjson.decode, raw)
if not ok or type(state) ~= 'table' then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 0
end
if type(state.expiresAt) ~= 'string' or state.expiresAt <= ARGV[3] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
local attempts = tonumber(state.attempts) or 0
local maximum = tonumber(ARGV[4])
if attempts >= maximum then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 2
end
if state.codeDigest == ARGV[2] and ARGV[2] ~= '' then
  state.codeDigest = ''
  state.verifiedAt = ARGV[3]
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 3
end
attempts = attempts + 1
state.attempts = attempts
if attempts >= maximum then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 2
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 4
`;

export async function consumeCallerVerificationCode(
  scope: TenantCallScope,
  suppliedDigest: string,
  maximumAttempts: number,
  now = new Date()
): Promise<'missing' | 'expired' | 'locked' | 'verified' | 'invalid'> {
  const result = await withCommandTimeout(
    'verifying caller code',
    redis.eval(
      VERIFY_CALLER_CODE_SCRIPT,
      1,
      stateKey(scope),
      'callerVerification',
      suppliedDigest,
      now.toISOString(),
      String(maximumAttempts),
      String(stateTtlSeconds)
    ) as Promise<number>
  );
  return (['missing', 'expired', 'locked', 'verified', 'invalid'] as const)[Number(result)]
    ?? 'missing';
}

export async function clearCallState(clinicId: string, callId: string): Promise<void> {
  try {
    await withCommandTimeout('clearing state', redis.del(stateKey({ clinicId, callId })));
  } catch (error) {
    // Cleanup is best effort. TTL guarantees eventual removal and an unavailable
    // cache must never make an end-of-call webhook fail or retry indefinitely.
    console.warn(
      'Call state cleanup deferred to TTL:',
      error instanceof Error ? error.message : 'unknown Redis error'
    );
  }
}
