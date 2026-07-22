import { type ProviderAccount, type ProviderResource } from '@prisma/client';
import crypto from 'crypto';
import twilio from 'twilio';
import { z } from 'zod';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../auth/secretBox';

export const providerSchema = z.enum(['vapi', 'twilio']);
export type SupportedProvider = z.infer<typeof providerSchema>;

export const accountStatusSchema = z.enum(['provisioning', 'active', 'inactive']);
export const resourceStatusSchema = z.enum(['provisioning', 'active', 'inactive']);

const vapiIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid Vapi identifier');
const twilioAccountSid = z.string().trim().regex(/^AC[a-fA-F0-9]{32}$/, 'Invalid Twilio Account SID');
const twilioMessagingServiceSid = z
  .string()
  .trim()
  .regex(/^MG[a-fA-F0-9]{32}$/, 'Invalid Twilio Messaging Service SID');
const e164Phone = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Phone number must use E.164 format');
const nullableDisplayName = z
  .union([z.string().trim().min(1).max(160), z.null()])
  .optional();

const vapiCredentialsSchema = z.object({
  apiKey: z.string().trim().min(16).max(512),
}).strict();

const twilioCredentialsSchema = z.object({
  accountSid: twilioAccountSid,
  authToken: z.string().trim().min(16).max(256),
}).strict();

const vapiAccountConfigSchema = z.object({
  environment: z.enum(['production', 'sandbox']).optional(),
  credentialSource: z.enum(['tenant', 'platform']).optional().default('tenant'),
  providerOrganizationId: vapiIdentifier.optional(),
}).strict().superRefine((config, context) => {
  if (config.credentialSource === 'platform' && !config.providerOrganizationId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerOrganizationId'],
      message: 'Platform-managed Vapi accounts require a verified provider organization ID',
    });
  }
});

const twilioAccountConfigSchema = z.object({
  region: z.string().trim().regex(/^[a-z0-9-]{1,32}$/).optional(),
  edge: z.string().trim().regex(/^[a-z0-9-]{1,32}$/).optional(),
}).strict();

const vapiPhoneConfigSchema = z.object({
  direction: z.enum(['inbound', 'outbound', 'both']).optional(),
  inboundAssistantId: vapiIdentifier.optional(),
  admissionVerifiedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const vapiAssistantConfigSchema = z.object({
  purpose: z.enum(['receptionist', 'reminder', 'outbound', 'general']).optional(),
  version: z.string().trim().min(1).max(100).optional(),
}).strict();

const twilioPhoneConfigSchema = z.object({
  messagingServiceSid: twilioMessagingServiceSid.optional(),
}).strict();

const twilioMessagingServiceConfigSchema = z.object({
  from: e164Phone.optional(),
}).strict();

const accountCommon = {
  status: accountStatusSchema.optional().default('provisioning'),
};

export const providerAccountCreateSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('vapi'),
    externalAccountId: vapiIdentifier.optional(),
    credentials: vapiCredentialsSchema,
    config: vapiAccountConfigSchema.optional(),
    ...accountCommon,
  }).strict(),
  z.object({
    provider: z.literal('twilio'),
    externalAccountId: twilioAccountSid,
    credentials: twilioCredentialsSchema,
    config: twilioAccountConfigSchema.optional(),
    ...accountCommon,
  }).strict(),
]);

export const providerAccountUpdateSchema = z.object({
  externalAccountId: z.string().trim().min(1).max(200).optional(),
  status: accountStatusSchema.optional(),
  config: z.unknown().optional(),
}).strict().refine(body => Object.keys(body).length > 0, 'At least one field is required');

export const credentialRotationSchema = z.object({
  credentials: z.unknown(),
}).strict();

const resourceCommon = {
  providerAccountId: z.string().uuid(),
  clinicId: z.string().uuid().nullable().optional(),
  displayName: nullableDisplayName,
  status: resourceStatusSchema.optional().default('provisioning'),
};

export const providerResourceCreateSchema = z.union([
  z.object({
    ...resourceCommon,
    provider: z.literal('vapi'),
    resourceType: z.literal('phone_number'),
    externalId: vapiIdentifier,
    clinicId: z.string().uuid(),
    config: vapiPhoneConfigSchema.optional(),
  }).strict(),
  z.object({
    provider: z.literal('vapi'),
    resourceType: z.literal('assistant'),
    externalId: vapiIdentifier,
    config: vapiAssistantConfigSchema.optional(),
    ...resourceCommon,
  }).strict(),
  z.object({
    provider: z.literal('twilio'),
    resourceType: z.literal('phone_number'),
    externalId: e164Phone,
    config: twilioPhoneConfigSchema.optional(),
    ...resourceCommon,
  }).strict(),
  z.object({
    provider: z.literal('twilio'),
    resourceType: z.literal('messaging_service'),
    externalId: twilioMessagingServiceSid,
    config: twilioMessagingServiceConfigSchema.optional(),
    ...resourceCommon,
  }).strict(),
]);

export const providerResourceUpdateSchema = z.object({
  providerAccountId: z.string().uuid().optional(),
  clinicId: z.string().uuid().nullable().optional(),
  externalId: z.string().trim().min(1).max(200).optional(),
  displayName: nullableDisplayName,
  status: resourceStatusSchema.optional(),
  config: z.unknown().optional(),
}).strict().refine(body => Object.keys(body).length > 0, 'At least one field is required');

export const providerEntityIdSchema = z.string().uuid();

type ProviderCredentials =
  | z.infer<typeof vapiCredentialsSchema>
  | z.infer<typeof twilioCredentialsSchema>;

export type ProviderCredentialSource = 'tenant' | 'platform';

const PLATFORM_VAPI_EXTERNAL_ACCOUNT_PREFIX = 'platform:';

function platformVapiApiKey(): string {
  if (process.env.PLATFORM_VAPI_ENABLED !== 'true') {
    throw new Error('Platform-funded Vapi is not enabled');
  }
  return vapiCredentialsSchema.parse({ apiKey: process.env.PLATFORM_VAPI_API_KEY }).apiKey;
}

export class ProviderOwnershipVerificationError extends Error {
  constructor(
    message: string,
    public readonly reason: 'not_owned' | 'credentials_rejected' | 'provider_unavailable'
  ) {
    super(message);
  }
}

export function providerCredentialPurpose(
  organizationId: string,
  provider: SupportedProvider
): string {
  return `provider-account:${organizationId}:${provider}`;
}

export function parseExternalAccountId(provider: SupportedProvider, value: unknown): string {
  return (provider === 'vapi' ? vapiIdentifier : twilioAccountSid).parse(value);
}

export function parseAccountConfig(provider: SupportedProvider, value: unknown): Record<string, unknown> {
  const schema = provider === 'vapi' ? vapiAccountConfigSchema : twilioAccountConfigSchema;
  return schema.parse(value ?? {});
}

export function providerCredentialSource(account: {
  provider: string;
  config: unknown;
}): ProviderCredentialSource {
  if (account.provider !== 'vapi') return 'tenant';
  const parsed = vapiAccountConfigSchema.safeParse(account.config ?? {});
  return parsed.success && parsed.data.credentialSource === 'platform' ? 'platform' : 'tenant';
}

export function isPlatformManagedVapiAccount(account: {
  organizationId: string;
  provider: string;
  externalAccountId: string;
  config: unknown;
}): boolean {
  return (
    account.provider === 'vapi' &&
    providerCredentialSource(account) === 'platform' &&
    account.externalAccountId === platformVapiExternalAccountId(account.organizationId)
  );
}

export function platformVapiExternalAccountId(organizationId: string): string {
  return `${PLATFORM_VAPI_EXTERNAL_ACCOUNT_PREFIX}${z.string().uuid().parse(organizationId)}`;
}

export function vapiProviderOrganizationId(account: {
  provider: string;
  config: unknown;
}): string | null {
  if (account.provider !== 'vapi') return null;
  const parsed = vapiAccountConfigSchema.safeParse(account.config ?? {});
  return parsed.success ? parsed.data.providerOrganizationId ?? null : null;
}

export function parseResourceExternalId(
  provider: SupportedProvider,
  resourceType: string,
  value: unknown
): string {
  if (provider === 'vapi' && ['phone_number', 'assistant'].includes(resourceType)) {
    return vapiIdentifier.parse(value);
  }
  if (provider === 'twilio' && resourceType === 'phone_number') {
    return e164Phone.parse(value);
  }
  if (provider === 'twilio' && resourceType === 'messaging_service') {
    return twilioMessagingServiceSid.parse(value);
  }
  throw new Error('Unsupported provider resource type');
}

export function parseResourceConfig(
  provider: SupportedProvider,
  resourceType: string,
  value: unknown
): Record<string, unknown> {
  let schema: z.ZodType<Record<string, unknown>>;
  if (provider === 'vapi' && resourceType === 'phone_number') schema = vapiPhoneConfigSchema;
  else if (provider === 'vapi' && resourceType === 'assistant') schema = vapiAssistantConfigSchema;
  else if (provider === 'twilio' && resourceType === 'phone_number') schema = twilioPhoneConfigSchema;
  else if (provider === 'twilio' && resourceType === 'messaging_service') {
    schema = twilioMessagingServiceConfigSchema;
  } else {
    throw new Error('Unsupported provider resource type');
  }
  return schema.parse(value ?? {});
}

export function parseProviderCredentials(
  provider: SupportedProvider,
  value: unknown,
  externalAccountId: string
): ProviderCredentials {
  const credentials = (provider === 'vapi'
    ? vapiCredentialsSchema
    : twilioCredentialsSchema
  ).parse(value);

  if (
    provider === 'twilio' &&
    'accountSid' in credentials &&
    credentials.accountSid !== externalAccountId
  ) {
    throw new Error('Twilio credentials must belong to the configured account SID');
  }
  return credentials;
}

export function encryptProviderCredentials(
  organizationId: string,
  provider: SupportedProvider,
  externalAccountId: string,
  value: unknown
): { credentialsEncrypted: string; credentialKeyVersion: string | null } {
  const credentials = parseProviderCredentials(provider, value, externalAccountId);
  const credentialsEncrypted = encryptSecret(
    JSON.stringify(credentials),
    providerCredentialPurpose(organizationId, provider)
  );
  const credentialKeyVersion = isEncryptedSecret(credentialsEncrypted)
    ? credentialsEncrypted.split(':')[2] ?? null
    : null;
  return { credentialsEncrypted, credentialKeyVersion };
}

export function decryptProviderCredentials(
  account: {
    organizationId: string;
    provider: string;
    externalAccountId: string;
    credentialsEncrypted: string | null;
    config: unknown;
  }
): ProviderCredentials {
  const provider = providerSchema.parse(account.provider);
  if (provider === 'vapi') {
    const config = vapiAccountConfigSchema.parse(account.config ?? {});
    if (config.credentialSource === 'platform') {
      if (!isPlatformManagedVapiAccount(account)) {
        throw new Error('The platform-managed Vapi account attribution is invalid');
      }
      if (account.credentialsEncrypted) {
        throw new Error('Platform-managed Vapi accounts cannot contain tenant credentials');
      }
      return { apiKey: platformVapiApiKey() };
    }
  }
  if (!account.credentialsEncrypted) throw new Error('Provider credentials are not configured');
  const plaintext = decryptSecret(
    account.credentialsEncrypted,
    providerCredentialPurpose(account.organizationId, provider)
  );
  return parseProviderCredentials(provider, JSON.parse(plaintext), account.externalAccountId);
}

export function providerAccountReadinessIssues(
  account: {
    organizationId: string;
    provider: string;
    externalAccountId: string;
    credentialsEncrypted: string | null;
    config: unknown;
  }
): string[] {
  const issues: string[] = [];
  const providerResult = providerSchema.safeParse(account.provider);
  if (!providerResult.success) return ['Unsupported provider'];
  const provider = providerResult.data;

  if (!parseExternalAccountIdSafe(provider, account.externalAccountId)) {
    issues.push('External account identifier is invalid');
  }
  try {
    parseAccountConfig(provider, account.config);
  } catch {
    issues.push('Account configuration is invalid');
  }
  if (
    provider === 'vapi' &&
    providerCredentialSource(account) === 'platform' &&
    !isPlatformManagedVapiAccount(account)
  ) {
    issues.push('Platform-managed account attribution is invalid');
  }
  try {
    decryptProviderCredentials(account);
  } catch {
    issues.push('Credentials are missing or invalid');
  }
  return issues;
}

function parseExternalAccountIdSafe(provider: SupportedProvider, value: unknown): boolean {
  try {
    parseExternalAccountId(provider, value);
    return true;
  } catch {
    return false;
  }
}

export function publicAccountConfig(provider: string, value: unknown): Record<string, unknown> | null {
  const parsedProvider = providerSchema.safeParse(provider);
  if (!parsedProvider.success) return null;
  try {
    const parsed = parseAccountConfig(parsedProvider.data, value);
    if (parsedProvider.data === 'vapi') {
      // The provider organization identifier is an operator-side attribution
      // detail. Tenants only need to know who controls the credential.
      return {
        ...(typeof parsed.environment === 'string' ? { environment: parsed.environment } : {}),
        credentialSource: parsed.credentialSource ?? 'tenant',
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

export function publicResourceConfig(
  provider: string,
  resourceType: string,
  value: unknown
): Record<string, unknown> | null {
  const parsedProvider = providerSchema.safeParse(provider);
  if (!parsedProvider.success) return null;
  try {
    return parseResourceConfig(parsedProvider.data, resourceType, value);
  } catch {
    return null;
  }
}

function providerHttpErrorReason(error: unknown): ProviderOwnershipVerificationError {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  if (status === 401 || status === 403) {
    return new ProviderOwnershipVerificationError(
      'Provider credentials were rejected',
      'credentials_rejected'
    );
  }
  if (status === 404) {
    return new ProviderOwnershipVerificationError(
      'The resource is not owned by this provider account',
      'not_owned'
    );
  }
  return new ProviderOwnershipVerificationError(
    'The provider could not verify resource ownership',
    'provider_unavailable'
  );
}

/**
 * Authenticate an account before its globally unique identifier is reserved.
 * Vapi does not expose a stable public account ID in the resource APIs used by
 * this product, so its canonical local ID is a non-reversible key fingerprint.
 */
export async function verifyProviderAccountCredentials(
  provider: SupportedProvider,
  externalAccountId: string | undefined,
  value: unknown
): Promise<string> {
  if (provider === 'vapi') {
    const credentials = vapiCredentialsSchema.parse(value);
    let response: Response;
    try {
      response = await fetch('https://api.vapi.ai/assistant?limit=1', {
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new ProviderOwnershipVerificationError(
        'Vapi could not verify the account credentials',
        'provider_unavailable'
      );
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ProviderOwnershipVerificationError(
        'Vapi credentials were rejected',
        'credentials_rejected'
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderOwnershipVerificationError(
        'Vapi could not verify the account credentials',
        'provider_unavailable'
      );
    }
    await response.body?.cancel();
    return `key:${crypto.createHash('sha256').update(credentials.apiKey).digest('hex').slice(0, 48)}`;
  }

  const accountSid = twilioAccountSid.parse(externalAccountId);
  const credentials = twilioCredentialsSchema.parse(value);
  if (credentials.accountSid !== accountSid) {
    throw new ProviderOwnershipVerificationError(
      'Twilio credentials do not match the account SID',
      'credentials_rejected'
    );
  }
  const client = twilio(credentials.accountSid, credentials.authToken, {
    accountSid: credentials.accountSid,
  });
  try {
    const account = await client.api.accounts(credentials.accountSid).fetch();
    if (account.sid !== credentials.accountSid) {
      throw new ProviderOwnershipVerificationError(
        'Twilio account ownership could not be verified',
        'not_owned'
      );
    }
    return account.sid;
  } catch (error) {
    if (error instanceof ProviderOwnershipVerificationError) throw error;
    throw providerHttpErrorReason(error);
  }
}

/** Verify the external resource is visible through this account's credentials. */
export async function verifyProviderResourceOwnership(
  account: Pick<
    ProviderAccount,
    'organizationId' | 'provider' | 'externalAccountId' | 'credentialsEncrypted' | 'config'
  >,
  resource: Pick<ProviderResource, 'provider' | 'resourceType' | 'externalId'>
): Promise<void> {
  const provider = providerSchema.parse(account.provider);
  if (provider !== resource.provider) {
    throw new ProviderOwnershipVerificationError(
      'Provider account and resource do not match',
      'not_owned'
    );
  }
  const credentials = decryptProviderCredentials(account);

  if (provider === 'vapi') {
    const apiKey = (credentials as z.infer<typeof vapiCredentialsSchema>).apiKey;
    await verifyVapiResourceWithApiKey(
      apiKey,
      resource.resourceType,
      resource.externalId,
      vapiProviderOrganizationId(account)
    );
    return;
  }

  const twilioCredentials = credentials as z.infer<typeof twilioCredentialsSchema>;
  const client = twilio(twilioCredentials.accountSid, twilioCredentials.authToken, {
    accountSid: twilioCredentials.accountSid,
  });
  try {
    if (resource.resourceType === 'phone_number') {
      const matches = await client.incomingPhoneNumbers.list({
        phoneNumber: resource.externalId,
        limit: 2,
      });
      if (!matches.some(item => item.phoneNumber === resource.externalId)) {
        throw new ProviderOwnershipVerificationError(
          'The Twilio phone number is not owned by this account',
          'not_owned'
        );
      }
      return;
    }

    const service = await client.messaging.v1.services(resource.externalId).fetch();
    if (service.sid !== resource.externalId) {
      throw new ProviderOwnershipVerificationError(
        'The Twilio Messaging Service is not owned by this account',
        'not_owned'
      );
    }
  } catch (error) {
    if (error instanceof ProviderOwnershipVerificationError) throw error;
    throw providerHttpErrorReason(error);
  }
}

export interface VerifiedVapiResource {
  id: string;
  providerOrganizationId: string;
  maxDurationSeconds?: number;
}

export const REQUIRED_RECEPTIONIST_VAPI_TOOLS = [
  'checkAvailability',
  'validateSlot',
  'storeName',
  'confirmDetails',
  'requestCallerVerification',
  'verifyCallerCode',
  'findAppointment',
  'cancelAppointment',
  'rescheduleAppointment',
  'bookAppointment',
] as const;

interface VapiToolConfiguration {
  name: string;
  serverUrl: string | null;
  credentialId: string | null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function vapiToolConfiguration(value: unknown): VapiToolConfiguration | null {
  const record = jsonRecord(value);
  if (!record) return null;
  const functionRecord = jsonRecord(record.function);
  const name = typeof functionRecord?.name === 'string'
    ? functionRecord.name
    : typeof record.name === 'string'
      ? record.name
      : null;
  if (!name) return null;
  const server = jsonRecord(record.server);
  return {
    name,
    serverUrl: typeof server?.url === 'string' ? server.url : null,
    credentialId: typeof server?.credentialId === 'string' ? server.credentialId : null,
  };
}

async function fetchVapiConfiguration(apiKey: string, path: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`https://api.vapi.ai${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ProviderOwnershipVerificationError(
      'Vapi could not verify assistant configuration',
      'provider_unavailable'
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ProviderOwnershipVerificationError(
      'Vapi credentials were rejected',
      'credentials_rejected'
    );
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new ProviderOwnershipVerificationError(
      'The Vapi assistant or tool is not owned by this account',
      'not_owned'
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderOwnershipVerificationError(
      'Vapi could not verify assistant configuration',
      'provider_unavailable'
    );
  }
  const payload = await response.json();
  const record = jsonRecord(payload);
  if (!record) {
    throw new ProviderOwnershipVerificationError(
      'Vapi returned invalid assistant configuration',
      'provider_unavailable'
    );
  }
  return record;
}

export function configuredVapiWebhookUrl(): string {
  const value = process.env.VAPI_WEBHOOK_URL ?? new URL(
    '/api/webhook/vapi',
    process.env.PUBLIC_API_URL ?? 'http://localhost:3001'
  ).toString();
  const parsed = new URL(value);
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('The production Vapi webhook URL must use HTTPS');
  }
  return parsed.toString();
}

async function verifyVapiPhoneAdmissionWithApiKey(input: {
  apiKey: string;
  phoneNumberId: string;
  expectedProviderOrganizationId?: string | null;
  expectedWebhookUrl: string;
}): Promise<{ providerOrganizationId: string; credentialId: string }> {
  const normalizedExpectedUrl = new URL(input.expectedWebhookUrl).toString();
  const phoneNumber = await fetchVapiConfiguration(
    input.apiKey,
    `/phone-number/${encodeURIComponent(input.phoneNumberId)}`
  );
  const providerOrganizationId = vapiIdentifier.safeParse(phoneNumber.orgId);
  if (
    phoneNumber.id !== input.phoneNumberId ||
    !providerOrganizationId.success ||
    (input.expectedProviderOrganizationId &&
      providerOrganizationId.data !== input.expectedProviderOrganizationId)
  ) {
    throw new ProviderOwnershipVerificationError(
      'The Vapi phone-number attribution changed during verification',
      'not_owned'
    );
  }
  if (typeof phoneNumber.assistantId === 'string' && phoneNumber.assistantId.trim()) {
    throw new Error('The Vapi phone number must not have a fixed assistantId; inbound admission uses assistant-request');
  }
  if (typeof phoneNumber.squadId === 'string' && phoneNumber.squadId.trim()) {
    throw new Error('The Vapi phone number must not have a fixed squadId; inbound admission uses assistant-request');
  }
  const phoneServer = jsonRecord(phoneNumber.server);
  const phoneServerUrl = typeof phoneServer?.url === 'string'
    ? phoneServer.url
    : typeof phoneNumber.serverUrl === 'string'
      ? phoneNumber.serverUrl
      : null;
  if (!phoneServerUrl || new URL(phoneServerUrl).toString() !== normalizedExpectedUrl) {
    throw new Error(`The Vapi phone-number server URL must be ${normalizedExpectedUrl}`);
  }
  const credentialId = typeof phoneServer?.credentialId === 'string'
    ? phoneServer.credentialId
    : null;
  if (!credentialId) {
    throw new Error('The Vapi phone-number server must use a Custom Credential for assistant-request authentication');
  }
  return { providerOrganizationId: providerOrganizationId.data, credentialId };
}

export async function verifyVapiPhoneAdmissionConfiguration(
  account: Pick<
    ProviderAccount,
    'organizationId' | 'provider' | 'externalAccountId' | 'credentialsEncrypted' | 'config'
  >,
  phoneNumberId: string,
  expectedWebhookUrl = configuredVapiWebhookUrl()
): Promise<string> {
  if (account.provider !== 'vapi') throw new Error('Vapi phone admission requires a Vapi account');
  const credentials = decryptProviderCredentials(account);
  if (!('apiKey' in credentials)) throw new Error('Vapi API credentials are unavailable');
  const verified = await verifyVapiPhoneAdmissionWithApiKey({
    apiKey: credentials.apiKey,
    phoneNumberId,
    expectedProviderOrganizationId: vapiProviderOrganizationId(account),
    expectedWebhookUrl,
  });
  return verified.providerOrganizationId;
}

async function verifyVapiReceptionistWithApiKey(input: {
  apiKey: string;
  phoneNumberId: string;
  assistantId: string;
  expectedProviderOrganizationId?: string | null;
  expectedWebhookUrl: string;
  expectedMaxDurationSeconds?: number;
}): Promise<string> {
  const normalizedExpectedUrl = new URL(input.expectedWebhookUrl).toString();
  const admission = await verifyVapiPhoneAdmissionWithApiKey({
    apiKey: input.apiKey,
    phoneNumberId: input.phoneNumberId,
    expectedProviderOrganizationId: input.expectedProviderOrganizationId,
    expectedWebhookUrl: normalizedExpectedUrl,
  });
  const { providerOrganizationId, credentialId: admissionCredentialId } = admission;

  const assistant = await fetchVapiConfiguration(
    input.apiKey,
    `/assistant/${encodeURIComponent(input.assistantId)}`
  );
  if (assistant.id !== input.assistantId || assistant.orgId !== providerOrganizationId) {
    throw new ProviderOwnershipVerificationError(
      'The Vapi assistant and phone number must belong to the same provider organization',
      'not_owned'
    );
  }
  if (input.expectedMaxDurationSeconds !== undefined) {
    const maxDurationSeconds = Number(assistant.maxDurationSeconds);
    if (
      !Number.isInteger(maxDurationSeconds) ||
      maxDurationSeconds !== input.expectedMaxDurationSeconds
    ) {
      throw new Error(
        `The Vapi assistant maxDurationSeconds must equal ${input.expectedMaxDurationSeconds}`
      );
    }
  }
  const server = jsonRecord(assistant.server);
  const assistantServerUrl = typeof server?.url === 'string'
    ? server.url
    : typeof assistant.serverUrl === 'string'
      ? assistant.serverUrl
      : null;
  const credentialId = typeof server?.credentialId === 'string'
    ? server.credentialId
    : null;
  if (!assistantServerUrl || new URL(assistantServerUrl).toString() !== normalizedExpectedUrl) {
    throw new Error(`The Vapi assistant server URL must be ${normalizedExpectedUrl}`);
  }
  if (!credentialId || credentialId !== admissionCredentialId) {
    throw new Error('The Vapi phone number and assistant must use the same Custom Credential');
  }
  const serverMessages = Array.isArray(assistant.serverMessages)
    ? assistant.serverMessages.filter((value): value is string => typeof value === 'string')
    : [];
  for (const requiredMessage of ['tool-calls', 'end-of-call-report']) {
    if (!serverMessages.includes(requiredMessage)) {
      throw new Error(`The Vapi assistant must enable the ${requiredMessage} server message`);
    }
  }

  const model = jsonRecord(assistant.model) ?? {};
  const embedded = [
    ...(Array.isArray(model.tools) ? model.tools : []),
    ...(Array.isArray(model.functions) ? model.functions : []),
    ...(Array.isArray(assistant.tools) ? assistant.tools : []),
  ].map(vapiToolConfiguration).filter((value): value is VapiToolConfiguration => Boolean(value));
  const toolIds = [
    ...(Array.isArray(model.toolIds) ? model.toolIds : []),
    ...(Array.isArray(assistant.toolIds) ? assistant.toolIds : []),
  ].filter((value): value is string => typeof value === 'string' && value.length <= 200);
  const fetchedTools = await Promise.all([...new Set(toolIds)].slice(0, 100).map(async toolId => {
    const tool = await fetchVapiConfiguration(input.apiKey, `/tool/${encodeURIComponent(toolId)}`);
    if (typeof tool.orgId === 'string' && tool.orgId !== providerOrganizationId) {
      throw new ProviderOwnershipVerificationError(
        'A Vapi assistant tool belongs to a different provider organization',
        'not_owned'
      );
    }
    return vapiToolConfiguration(tool);
  }));
  const configurations = [
    ...embedded,
    ...fetchedTools.filter((value): value is VapiToolConfiguration => Boolean(value)),
  ];
  const byName = new Map(configurations.map(configuration => [configuration.name, configuration]));
  const missing = REQUIRED_RECEPTIONIST_VAPI_TOOLS.filter(name => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`The Vapi assistant is missing required tools: ${missing.join(', ')}`);
  }
  for (const name of REQUIRED_RECEPTIONIST_VAPI_TOOLS) {
    const toolConfiguration = byName.get(name);
    if (
      toolConfiguration?.serverUrl &&
      (
        new URL(toolConfiguration.serverUrl).toString() !== normalizedExpectedUrl ||
        toolConfiguration.credentialId !== admissionCredentialId
      )
    ) {
      throw new Error(`Vapi tool ${name} overrides the authenticated tenant webhook configuration`);
    }
  }
  return providerOrganizationId;
}

export async function verifyVapiReceptionistConfiguration(
  account: Pick<
    ProviderAccount,
    'organizationId' | 'provider' | 'externalAccountId' | 'credentialsEncrypted' | 'config'
  >,
  input: {
    phoneNumberId: string;
    assistantId: string;
    expectedMaxDurationSeconds: number;
    expectedWebhookUrl?: string;
  }
): Promise<string> {
  if (account.provider !== 'vapi') throw new Error('Vapi receptionist verification requires a Vapi account');
  const credentials = decryptProviderCredentials(account);
  if (!('apiKey' in credentials)) throw new Error('Vapi API credentials are unavailable');
  return verifyVapiReceptionistWithApiKey({
    apiKey: credentials.apiKey,
    phoneNumberId: input.phoneNumberId,
    assistantId: input.assistantId,
    expectedProviderOrganizationId: vapiProviderOrganizationId(account),
    expectedWebhookUrl: input.expectedWebhookUrl ?? configuredVapiWebhookUrl(),
    expectedMaxDurationSeconds: input.expectedMaxDurationSeconds,
  });
}

/**
 * Fail closed before activating a platform receptionist. Vapi routes function
 * calls by tool/assistant server precedence, so every required tool must either
 * inherit the authenticated assistant server or point to the same endpoint.
 */
export async function verifyPlatformVapiReceptionistConfiguration(input: {
  phoneNumberId: string;
  assistantId: string;
  providerOrganizationId: string;
  expectedWebhookUrl: string;
}): Promise<void> {
  const apiKey = platformVapiApiKey();
  await verifyVapiReceptionistWithApiKey({
    apiKey,
    phoneNumberId: input.phoneNumberId,
    assistantId: input.assistantId,
    expectedProviderOrganizationId: input.providerOrganizationId,
    expectedWebhookUrl: input.expectedWebhookUrl,
  });
}

/**
 * Operator provisioning uses the same ownership proof as tenant BYO setup.
 * Requiring orgId prevents two resources visible to a broad platform key from
 * being accidentally bound across different Vapi organizations.
 */
export async function verifyPlatformVapiResource(
  resourceType: 'phone_number' | 'assistant',
  externalId: string,
  expectedProviderOrganizationId?: string
): Promise<VerifiedVapiResource> {
  const credentials = { apiKey: platformVapiApiKey() };
  return verifyVapiResourceWithApiKey(
    credentials.apiKey,
    resourceType,
    parseResourceExternalId('vapi', resourceType, externalId),
    expectedProviderOrganizationId
  );
}

async function verifyVapiResourceWithApiKey(
  apiKey: string,
  resourceType: string,
  externalId: string,
  expectedProviderOrganizationId?: string | null
): Promise<VerifiedVapiResource> {
  const endpoint = resourceType === 'phone_number' ? 'phone-number' : 'assistant';
  let response: Response;
  try {
    response = await fetch(
      `https://api.vapi.ai/${endpoint}/${encodeURIComponent(externalId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
  } catch {
    throw new ProviderOwnershipVerificationError(
      'Vapi could not verify resource ownership',
      'provider_unavailable'
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ProviderOwnershipVerificationError(
      'Vapi credentials were rejected',
      'credentials_rejected'
    );
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new ProviderOwnershipVerificationError(
      'The Vapi resource is not owned by this account',
      'not_owned'
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderOwnershipVerificationError(
      'Vapi could not verify resource ownership',
      'provider_unavailable'
    );
  }
  const payload = await response.json() as {
    id?: unknown;
    orgId?: unknown;
    maxDurationSeconds?: unknown;
  };
  const providerOrganizationId = vapiIdentifier.safeParse(payload.orgId);
  if (payload.id !== externalId || !providerOrganizationId.success) {
    throw new ProviderOwnershipVerificationError(
      'Vapi returned an unattributable resource',
      'not_owned'
    );
  }
  if (
    expectedProviderOrganizationId &&
    providerOrganizationId.data !== expectedProviderOrganizationId
  ) {
    throw new ProviderOwnershipVerificationError(
      'The Vapi resource belongs to a different provider organization',
      'not_owned'
    );
  }
  const maxDurationSeconds = Number(payload.maxDurationSeconds);
  return {
    id: externalId,
    providerOrganizationId: providerOrganizationId.data,
    ...(Number.isInteger(maxDurationSeconds) ? { maxDurationSeconds } : {}),
  };
}
