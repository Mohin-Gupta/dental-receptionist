import { decryptSecret, encryptSecret } from '../auth/secretBox';
import {
  getRazorpayPlans,
  getRazorpayRuntimeConfig,
  getRazorpayWebhookSecrets,
} from '../billing/config';
import { getDataRetentionConfig } from './dataRetention';
import { getConfiguredPriceVersions } from '../billing/priceCatalog';
import { getCommunicationPreferenceHmacKeyring } from './communicationPreferences';
import { getOperationsConfig } from './operations';

function requireValues(names: string[]) {
  const missing = names.filter(name => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

function requireHttpsUrl(name: string): { raw: string; url: URL } {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  if (raw !== raw.trim()) throw new Error(`${name} must not contain surrounding whitespace`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production`);
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  return { raw, url };
}

function requireHttpsOrigin(name: string, rawValue?: string) {
  const raw = rawValue ?? process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    raw !== url.origin
  ) {
    throw new Error(
      `${name} must be an exact HTTPS origin without credentials, path, query, or fragment`
    );
  }
}

function requireExactHttpsCallback(name: string, pathname: string) {
  const { raw, url } = requireHttpsUrl(name);
  if (
    url.pathname !== pathname ||
    url.search ||
    url.hash ||
    raw !== url.toString()
  ) {
    throw new Error(
      `${name} must be exactly an HTTPS URL ending in ${pathname} without a query or fragment`
    );
  }
}

function requireSecretLength(name: string, minimumBytes = 32) {
  const value = process.env[name];
  if (!value || Buffer.byteLength(value, 'utf8') < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes of entropy`);
  }
}

function validateIntegerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

export function validateRuntimeConfiguration(processRole: 'api' | 'worker' = 'api') {
  requireValues(['DATABASE_URL', 'REDIS_URL']);
  validateIntegerSetting('TRUST_PROXY_HOPS', 1, 0, 5);
  validateIntegerSetting('WEBHOOK_REQUESTS_PER_MINUTE', 600, 10, 100_000);
  validateIntegerSetting('JSON_BODY_LIMIT_BYTES', 1_048_576, 1_024, 10_485_760);
  validateIntegerSetting('URLENCODED_BODY_LIMIT_BYTES', 262_144, 1_024, 10_485_760);
  validateIntegerSetting('MFA_SENSITIVE_WINDOW_MINUTES', 30, 1, 24 * 60);
  validateIntegerSetting('MFA_ENROLLMENT_TTL_MINUTES', 10, 5, 30);
  validateIntegerSetting('SMTP_PORT', 587, 1, 65_535);
  getOperationsConfig({
    requireBearerToken: process.env.NODE_ENV === 'production' && processRole === 'api',
  });
  if (process.env.NODE_ENV !== 'production') return;

  if (
    process.env.PLATFORM_VAPI_ENABLED &&
    !['true', 'false'].includes(process.env.PLATFORM_VAPI_ENABLED)
  ) {
    throw new Error('PLATFORM_VAPI_ENABLED must be true or false');
  }
  if (
    process.env.PLATFORM_BOLNA_ENABLED &&
    !['true', 'false'].includes(process.env.PLATFORM_BOLNA_ENABLED)
  ) {
    throw new Error('PLATFORM_BOLNA_ENABLED must be true or false');
  }
  if (
    process.env.PLATFORM_VOBIZ_ENABLED &&
    !['true', 'false'].includes(process.env.PLATFORM_VOBIZ_ENABLED)
  ) {
    throw new Error('PLATFORM_VOBIZ_ENABLED must be true or false');
  }

  requireValues([
    'WEB_ORIGIN',
    'PUBLIC_API_URL',
    'VAPI_WEBHOOK_URL',
    'DATA_ENCRYPTION_KEYS',
    'DATA_ENCRYPTION_ACTIVE_KEY_ID',
    'OAUTH_STATE_SECRET',
    'CALLER_VERIFICATION_HMAC_SECRET',
    'VAPI_HMAC_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_EXPECT_KEY_MODE',
    'RAZORPAY_PLAN_CONFIG_JSON',
  ]);
  const webOrigins = process.env.WEB_ORIGIN!
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (webOrigins.length === 0) {
    throw new Error('WEB_ORIGIN must contain at least one HTTPS origin');
  }
  for (const origin of webOrigins) requireHttpsOrigin('Every WEB_ORIGIN', origin);
  requireHttpsOrigin('PUBLIC_API_URL');
  requireExactHttpsCallback('GOOGLE_REDIRECT_URI', '/api/auth/google/callback');
  requireExactHttpsCallback('VAPI_WEBHOOK_URL', '/api/webhook/vapi');
  requireSecretLength('OAUTH_STATE_SECRET');
  requireSecretLength('CALLER_VERIFICATION_HMAC_SECRET');
  requireSecretLength('VAPI_HMAC_SECRET');
  if (process.env.PLATFORM_VAPI_ENABLED === 'true') {
    requireValues(['PLATFORM_VAPI_API_KEY']);
  }
  // Bolna and Vobiz are added side by side with Vapi, not replacing it, and
  // are off by default — these checks only bite once an operator opts in,
  // exactly mirroring PLATFORM_VAPI_ENABLED above, so existing Vapi-only
  // production deployments are unaffected until Bolna is actually enabled.
  if (process.env.PLATFORM_BOLNA_ENABLED === 'true') {
    requireValues(['PLATFORM_BOLNA_API_KEY', 'BOLNA_WEBHOOK_SECRET', 'BOLNA_WEBHOOK_BASE_URL']);
  }
  if (process.env.PLATFORM_VOBIZ_ENABLED === 'true') {
    requireValues(['PLATFORM_VOBIZ_AUTH_ID', 'PLATFORM_VOBIZ_AUTH_TOKEN']);
  }

  // Parse and exercise the active key now, before the process accepts traffic.
  const probe = encryptSecret('runtime-key-check', 'runtime-configuration-check');
  if (decryptSecret(probe, 'runtime-configuration-check') !== 'runtime-key-check') {
    throw new Error('The data encryption keyring failed its startup check');
  }

  // A production SaaS process without a valid catalog must fail at deploy
  // time, not after the first customer tries to pay. Only the API receives and
  // verifies Razorpay webhook signatures; the worker consumes verified,
  // encrypted inbox rows and must not receive the endpoint signing secret.
  getRazorpayRuntimeConfig();
  getRazorpayPlans();
  if (processRole === 'api') getRazorpayWebhookSecrets();
  getConfiguredPriceVersions();
  getCommunicationPreferenceHmacKeyring();
  getDataRetentionConfig();
}
