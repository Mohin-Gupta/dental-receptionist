const DEFAULT_HEARTBEAT_NAME = 'background-worker';
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 15;
const DEFAULT_HEARTBEAT_MAX_AGE_SECONDS = 90;

function integerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function readinessRequirement(): boolean {
  const raw = process.env.REQUIRE_WORKER_HEARTBEAT_FOR_READINESS?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REQUIRE_WORKER_HEARTBEAT_FOR_READINESS must be explicitly true or false in production');
    }
    return false;
  }
  if (raw !== 'true' && raw !== 'false') {
    throw new Error('REQUIRE_WORKER_HEARTBEAT_FOR_READINESS must be true or false');
  }
  return raw === 'true';
}

function operationsToken(required: boolean): string | null {
  const token = process.env.OPERATIONS_BEARER_TOKEN;
  if (!token) {
    if (required) {
      throw new Error('OPERATIONS_BEARER_TOKEN is required in production');
    }
    return null;
  }
  if (
    token !== token.trim() ||
    /\s/.test(token) ||
    Buffer.byteLength(token, 'utf8') < 32 ||
    Buffer.byteLength(token, 'utf8') > 512 ||
    /REPLACE|CHANGE[_-]?ME/i.test(token)
  ) {
    throw new Error(
      'OPERATIONS_BEARER_TOKEN must be a non-placeholder token between 32 and 512 bytes with no whitespace'
    );
  }
  return token;
}

export function getOperationsConfig(options: { requireBearerToken?: boolean } = {}) {
  const workerName = process.env.WORKER_HEARTBEAT_NAME?.trim() || DEFAULT_HEARTBEAT_NAME;
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(workerName)) {
    throw new Error('WORKER_HEARTBEAT_NAME must contain 1 to 100 safe identifier characters');
  }

  const intervalSeconds = integerSetting(
    'WORKER_HEARTBEAT_INTERVAL_SECONDS',
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    5,
    300
  );
  const maxAgeSeconds = integerSetting(
    'WORKER_HEARTBEAT_MAX_AGE_SECONDS',
    DEFAULT_HEARTBEAT_MAX_AGE_SECONDS,
    15,
    3_600
  );
  if (maxAgeSeconds < intervalSeconds * 2) {
    throw new Error('WORKER_HEARTBEAT_MAX_AGE_SECONDS must be at least twice the heartbeat interval');
  }

  return {
    workerName,
    intervalSeconds,
    maxAgeSeconds,
    requireForReadiness: readinessRequirement(),
    bearerToken: operationsToken(options.requireBearerToken === true),
  };
}
