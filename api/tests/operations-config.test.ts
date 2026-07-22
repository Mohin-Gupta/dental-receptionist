import assert from 'node:assert/strict';
import test from 'node:test';
import { getOperationsConfig } from '../src/config/operations';

const MANAGED_ENV = [
  'NODE_ENV',
  'OPERATIONS_BEARER_TOKEN',
  'REQUIRE_WORKER_HEARTBEAT_FOR_READINESS',
  'WORKER_HEARTBEAT_NAME',
  'WORKER_HEARTBEAT_INTERVAL_SECONDS',
  'WORKER_HEARTBEAT_MAX_AGE_SECONDS',
] as const;

test('production operations configuration fails closed and accepts a valid policy', () => {
  const previous = Object.fromEntries(MANAGED_ENV.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED_ENV) delete process.env[name];
    process.env.NODE_ENV = 'production';

    assert.throws(
      () => getOperationsConfig({ requireBearerToken: true }),
      /REQUIRE_WORKER_HEARTBEAT_FOR_READINESS/
    );

    process.env.REQUIRE_WORKER_HEARTBEAT_FOR_READINESS = 'true';
    assert.throws(
      () => getOperationsConfig({ requireBearerToken: true }),
      /OPERATIONS_BEARER_TOKEN/
    );

    process.env.OPERATIONS_BEARER_TOKEN = 'short';
    assert.throws(
      () => getOperationsConfig({ requireBearerToken: true }),
      /between 32 and 512 bytes/
    );

    process.env.OPERATIONS_BEARER_TOKEN = 'kX3v8Jq7Zw2sHd5mRc9pLf4nTy6bUg1eQa0oWi';
    process.env.WORKER_HEARTBEAT_INTERVAL_SECONDS = '20';
    process.env.WORKER_HEARTBEAT_MAX_AGE_SECONDS = '30';
    assert.throws(
      () => getOperationsConfig({ requireBearerToken: true }),
      /at least twice/
    );

    process.env.WORKER_HEARTBEAT_MAX_AGE_SECONDS = '60';
    const config = getOperationsConfig({ requireBearerToken: true });
    assert.equal(config.requireForReadiness, true);
    assert.equal(config.intervalSeconds, 20);
    assert.equal(config.maxAgeSeconds, 60);
    assert.equal(config.workerName, 'background-worker');
  } finally {
    for (const name of MANAGED_ENV) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
