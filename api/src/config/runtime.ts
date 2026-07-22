import { decryptSecret, encryptSecret } from '../auth/secretBox';
import {
  getStripePlans,
  getStripeRuntimeConfig,
  getStripeWebhookSecrets,
} from '../billing/config';
import { getDataRetentionConfig } from './dataRetention';
import { getConfiguredPriceVersions } from '../billing/priceCatalog';
import { getCommunicationPreferenceHmacKeyring } from './communicationPreferences';
import { getOperationsConfig } from './operations';

function requireValues(names: string[]) {
  const missing = names.filter(name => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

function requireHttpsUrl(name: string) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production`);
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

  requireValues([
    'WEB_ORIGIN',
    'PUBLIC_API_URL',
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
    'TERMS_VERSION',
    'PRIVACY_VERSION',
    'STRIPE_API_VERSION',
  ]);
  for (const origin of process.env.WEB_ORIGIN!.split(',').map(value => value.trim()).filter(Boolean)) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:') throw new Error('Every WEB_ORIGIN must use HTTPS in production');
  }
  requireHttpsUrl('PUBLIC_API_URL');
  requireHttpsUrl('GOOGLE_REDIRECT_URI');
  if (process.env.VAPI_WEBHOOK_URL?.trim()) requireHttpsUrl('VAPI_WEBHOOK_URL');
  requireSecretLength('OAUTH_STATE_SECRET');
  requireSecretLength('CALLER_VERIFICATION_HMAC_SECRET');
  requireSecretLength('VAPI_HMAC_SECRET');
  if (process.env.PLATFORM_VAPI_ENABLED === 'true') {
    requireValues(['PLATFORM_VAPI_API_KEY']);
  }

  // Parse and exercise the active key now, before the process accepts traffic.
  const probe = encryptSecret('runtime-key-check', 'runtime-configuration-check');
  if (decryptSecret(probe, 'runtime-configuration-check') !== 'runtime-key-check') {
    throw new Error('The data encryption keyring failed its startup check');
  }

  // A production SaaS process without a valid catalog or webhook secret must
  // fail at deploy time, not after the first customer tries to pay.
  getStripeRuntimeConfig();
  getStripePlans();
  getStripeWebhookSecrets();
  getConfiguredPriceVersions();
  getCommunicationPreferenceHmacKeyring();
  getDataRetentionConfig();
}
