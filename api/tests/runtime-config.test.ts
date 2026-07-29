import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRuntimeConfiguration } from '../src/config/runtime';

const BASE_PRODUCTION_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  REQUIRE_WORKER_HEARTBEAT_FOR_READINESS: 'false',
  WEB_ORIGIN: 'https://app.example.com',
  PUBLIC_API_URL: 'https://api.example.com',
  VAPI_WEBHOOK_URL: 'https://api.example.com/api/webhook/vapi',
  DATA_ENCRYPTION_ACTIVE_KEY_ID: 'test-key',
  DATA_ENCRYPTION_KEYS: JSON.stringify({
    'test-key': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }),
  OAUTH_STATE_SECRET: 'o'.repeat(32),
  CALLER_VERIFICATION_HMAC_SECRET: 'c'.repeat(32),
  VAPI_HMAC_SECRET: 'v'.repeat(32),
  GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_REDIRECT_URI: 'https://api.example.com/api/auth/google/callback',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'smtp-user',
  SMTP_PASS: 'smtp-password',
  SMTP_FROM: 'no-reply@example.com',
  RAZORPAY_KEY_ID: 'rzp_test_12345678901234',
  RAZORPAY_KEY_SECRET: 'r'.repeat(32),
  RAZORPAY_EXPECT_KEY_MODE: 'test',
  RAZORPAY_PLAN_CONFIG_JSON: JSON.stringify({
    starter: {
      currency: 'INR',
      planId: 'plan_12345678901234',
      amountMinor: 100,
      period: 'monthly',
      interval: 1,
      quantity: 1,
      totalCount: 12,
      customerNotify: true,
      entitlements: {},
      trialDays: 0,
    },
  }),
  RAZORPAY_WEBHOOK_SECRET: 'w'.repeat(32),
  BILLING_PRICE_VERSIONS_JSON: '[]',
  COMMUNICATION_PREFERENCE_HMAC_ACTIVE_KEY_ID: 'preference-key',
  COMMUNICATION_PREFERENCE_HMAC_KEYS: JSON.stringify({
    'preference-key': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }),
  PROVIDER_WEBHOOK_PAYLOAD_RETENTION_DAYS: '30',
  COMMUNICATION_PAYLOAD_RETENTION_DAYS: '30',
  CALL_TRANSCRIPT_RETENTION_DAYS: '0',
  OUTBOX_TERMINAL_RETENTION_DAYS: '30',
  REGISTRATION_REQUEST_RETENTION_DAYS: '30',
  OPERATIONS_BEARER_TOKEN: 'operations-token-with-more-than-32-bytes',
} as const;

const OPTIONAL_MANAGED_ENV = [
  'APP_NAME',
  'BILLING_GRACE_PERIOD_DAYS',
  'JSON_BODY_LIMIT_BYTES',
  'MFA_ENROLLMENT_TTL_MINUTES',
  'MFA_SENSITIVE_WINDOW_MINUTES',
  'PLATFORM_VAPI_API_KEY',
  'PLATFORM_VAPI_ENABLED',
  'RAZORPAY_ACCOUNT_ID',
  'RAZORPAY_API_BASE_URL',
  'RAZORPAY_API_MAX_RETRIES',
  'RAZORPAY_API_TIMEOUT_MS',
  'RAZORPAY_CHECKOUT_NAME',
  'RAZORPAY_SUBSCRIPTION_AUTH_TTL_MINUTES',
  'RAZORPAY_WEBHOOK_SECRETS',
  'SMTP_PORT',
  'TRUST_PROXY_HOPS',
  'URLENCODED_BODY_LIMIT_BYTES',
  'WEBHOOK_REQUESTS_PER_MINUTE',
  'WORKER_HEARTBEAT_INTERVAL_SECONDS',
  'WORKER_HEARTBEAT_MAX_AGE_SECONDS',
  'WORKER_HEARTBEAT_NAME',
] as const;

const MANAGED_ENV = [
  ...Object.keys(BASE_PRODUCTION_ENV),
  ...OPTIONAL_MANAGED_ENV,
] as const;

function withProductionEnvironment(
  overrides: Record<string, string | undefined>,
  assertion: () => void
) {
  const previous = Object.fromEntries(MANAGED_ENV.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED_ENV) delete process.env[name];
    Object.assign(process.env, BASE_PRODUCTION_ENV);
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    assertion();
  } finally {
    for (const name of MANAGED_ENV) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('runtime configuration rejects invalid SMTP ports', () => {
  withProductionEnvironment({ NODE_ENV: 'test', SMTP_PORT: 'not-a-port' }, () => {
    assert.throws(() => validateRuntimeConfiguration(), /SMTP_PORT/);
  });

  withProductionEnvironment({ NODE_ENV: 'test', SMTP_PORT: '65536' }, () => {
    assert.throws(() => validateRuntimeConfiguration(), /SMTP_PORT/);
  });

  withProductionEnvironment({ NODE_ENV: 'test', SMTP_PORT: '587' }, () => {
    assert.doesNotThrow(() => validateRuntimeConfiguration());
  });
});

test('production runtime accepts canonical public URLs', () => {
  withProductionEnvironment({}, () => {
    assert.doesNotThrow(() => validateRuntimeConfiguration('api'));
  });
});

test('production runtime requires an explicit Vapi webhook URL', () => {
  withProductionEnvironment({ VAPI_WEBHOOK_URL: undefined }, () => {
    assert.throws(
      () => validateRuntimeConfiguration('api'),
      /Missing required environment variables: VAPI_WEBHOOK_URL/
    );
  });
});

test('production runtime rejects non-origin web and API URLs', () => {
  withProductionEnvironment({ WEB_ORIGIN: 'https://app.example.com/dashboard' }, () => {
    assert.throws(() => validateRuntimeConfiguration('api'), /Every WEB_ORIGIN must be an exact HTTPS origin/);
  });

  withProductionEnvironment({
    PUBLIC_API_URL: 'https://user:password@api.example.com/unexpected?token=secret#fragment',
  }, () => {
    assert.throws(() => validateRuntimeConfiguration('api'), /PUBLIC_API_URL must be an exact HTTPS origin/);
  });
});

test('production runtime rejects non-canonical provider callback URLs', () => {
  withProductionEnvironment({
    GOOGLE_REDIRECT_URI: 'https://api.example.com/api/auth/google/callback?next=dashboard',
  }, () => {
    assert.throws(() => validateRuntimeConfiguration('api'), /GOOGLE_REDIRECT_URI must be exactly/);
  });

  withProductionEnvironment({
    VAPI_WEBHOOK_URL: 'https://api.example.com/api/webhook/vapi/tenant',
  }, () => {
    assert.throws(() => validateRuntimeConfiguration('api'), /VAPI_WEBHOOK_URL must be exactly/);
  });
});

test('only the API process requires the Razorpay webhook signing secret', () => {
  withProductionEnvironment({ RAZORPAY_WEBHOOK_SECRET: undefined }, () => {
    assert.throws(
      () => validateRuntimeConfiguration('api'),
      /Razorpay webhook signing secret is not configured securely/
    );
    assert.doesNotThrow(() => validateRuntimeConfiguration('worker'));
  });
});
