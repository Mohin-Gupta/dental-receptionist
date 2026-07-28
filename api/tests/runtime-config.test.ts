import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRuntimeConfiguration } from '../src/config/runtime';

const MANAGED_ENV = ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'SMTP_PORT'] as const;

test('runtime configuration rejects invalid SMTP ports', () => {
  const previous = Object.fromEntries(MANAGED_ENV.map(name => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.REDIS_URL = 'redis://localhost:6379';

    process.env.SMTP_PORT = 'not-a-port';
    assert.throws(() => validateRuntimeConfiguration(), /SMTP_PORT/);

    process.env.SMTP_PORT = '65536';
    assert.throws(() => validateRuntimeConfiguration(), /SMTP_PORT/);

    process.env.SMTP_PORT = '587';
    assert.doesNotThrow(() => validateRuntimeConfiguration());
  } finally {
    for (const name of MANAGED_ENV) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
