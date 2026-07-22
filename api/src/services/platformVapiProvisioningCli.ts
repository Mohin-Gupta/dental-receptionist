import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import {
  isPlatformManagedVapiAccount,
  platformVapiExternalAccountId,
  configuredVapiWebhookUrl,
  vapiProviderOrganizationId,
  verifyPlatformVapiReceptionistConfiguration,
  verifyPlatformVapiResource,
} from './providerProvisioning';

const valueFlags = new Set([
  '--organization-id',
  '--clinic-id',
  '--phone-number-id',
  '--assistant-id',
  '--phone-display-name',
  '--assistant-display-name',
  '--assistant-scope',
]);
const booleanFlags = new Set(['--activate', '--confirm']);

const optionsSchema = z.object({
  organizationId: z.string().uuid(),
  clinicId: z.string().uuid(),
  phoneNumberId: z.string().trim().min(1).max(200),
  assistantId: z.string().trim().min(1).max(200),
  phoneDisplayName: z.string().trim().min(1).max(160).optional(),
  assistantDisplayName: z.string().trim().min(1).max(160).optional(),
  assistantScope: z.enum(['organization', 'clinic']),
  activate: z.boolean(),
  confirm: z.literal(true),
}).strict();

type Options = z.infer<typeof optionsSchema>;

function camelCaseFlag(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
}

function parseArguments(argv: string[]): Options {
  const values: Record<string, string | boolean> = {
    assistantScope: 'organization',
    activate: false,
    confirm: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (booleanFlags.has(flag)) {
      const key = camelCaseFlag(flag);
      values[key] = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    const key = camelCaseFlag(flag);
    values[key] = value;
    index += 1;
  }
  return optionsSchema.parse(values);
}

function configuredInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const phoneCap = configuredInteger(
    'PLATFORM_VAPI_MAX_PHONE_NUMBERS_PER_ORGANIZATION',
    10,
    1,
    100
  );
  const assistantCap = configuredInteger(
    'PLATFORM_VAPI_MAX_ASSISTANTS_PER_ORGANIZATION',
    10,
    1,
    100
  );
  const inboundCallCap = configuredInteger('VAPI_MAX_INBOUND_CALL_SECONDS', 900, 60, 7_200);

  const [organization, clinic] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: options.organizationId },
      select: { id: true, status: true },
    }),
    prisma.clinic.findFirst({
      where: {
        id: options.clinicId,
        organizationId: options.organizationId,
        status: 'active',
      },
      select: { id: true },
    }),
  ]);
  if (!organization) throw new Error('Organization not found');
  if (!clinic) throw new Error('Clinic is not active in the organization');
  if (options.activate && organization.status !== 'active') {
    throw new Error('The organization must be active before Vapi resources can be activated');
  }

  // Prove visibility and a shared Vapi org before reserving any global IDs.
  const phone = await verifyPlatformVapiResource('phone_number', options.phoneNumberId);
  const assistant = await verifyPlatformVapiResource(
    'assistant',
    options.assistantId,
    phone.providerOrganizationId
  );
  if (assistant.providerOrganizationId !== phone.providerOrganizationId) {
    throw new Error('The phone number and assistant belong to different Vapi organizations');
  }
  if (assistant.maxDurationSeconds !== inboundCallCap) {
    throw new Error(
      `The Vapi assistant maxDurationSeconds must equal VAPI_MAX_INBOUND_CALL_SECONDS (${inboundCallCap})`
    );
  }
  const expectedWebhookUrl = configuredVapiWebhookUrl();
  await verifyPlatformVapiReceptionistConfiguration({
    phoneNumberId: phone.id,
    assistantId: assistant.id,
    providerOrganizationId: assistant.providerOrganizationId,
    expectedWebhookUrl,
  });

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform-vapi:${options.organizationId}`}))`;

    const externalAccountId = platformVapiExternalAccountId(options.organizationId);
    const existingAccount = await tx.providerAccount.findUnique({
      where: {
        organizationId_provider: {
          organizationId: options.organizationId,
          provider: 'vapi',
        },
      },
    });
    if (existingAccount && !isPlatformManagedVapiAccount(existingAccount)) {
      throw new Error('The organization already uses tenant-owned Vapi credentials');
    }
    if (existingAccount?.credentialsEncrypted) {
      throw new Error('The platform Vapi account unexpectedly contains tenant credentials');
    }
    const existingProviderOrganizationId = existingAccount
      ? vapiProviderOrganizationId(existingAccount)
      : null;
    if (
      existingProviderOrganizationId &&
      existingProviderOrganizationId !== phone.providerOrganizationId
    ) {
      const existingResourceCount = await tx.providerResource.count({
        where: { providerAccountId: existingAccount!.id },
      });
      if (existingResourceCount > 0) {
        throw new Error('Cannot change the Vapi provider organization while resources are bound');
      }
    }

    const accountConfig: Prisma.InputJsonObject = {
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
      credentialSource: 'platform',
      providerOrganizationId: phone.providerOrganizationId,
    };
    const accountStatus = options.activate ? 'active' : existingAccount?.status ?? 'provisioning';
    const account = existingAccount
      ? await tx.providerAccount.update({
          where: { id: existingAccount.id },
          data: {
            externalAccountId,
            status: accountStatus,
            config: accountConfig,
            credentialsEncrypted: null,
            credentialKeyVersion: null,
          },
        })
      : await tx.providerAccount.create({
          data: {
            organizationId: options.organizationId,
            provider: 'vapi',
            externalAccountId,
            status: accountStatus,
            config: accountConfig,
          },
        });

    const [existingPhone, existingAssistant, phoneCount, assistantCount] = await Promise.all([
      tx.providerResource.findUnique({
        where: {
          provider_resourceType_externalId: {
            provider: 'vapi',
            resourceType: 'phone_number',
            externalId: phone.id,
          },
        },
      }),
      tx.providerResource.findUnique({
        where: {
          provider_resourceType_externalId: {
            provider: 'vapi',
            resourceType: 'assistant',
            externalId: assistant.id,
          },
        },
      }),
      tx.providerResource.count({
        where: { organizationId: options.organizationId, provider: 'vapi', resourceType: 'phone_number' },
      }),
      tx.providerResource.count({
        where: { organizationId: options.organizationId, provider: 'vapi', resourceType: 'assistant' },
      }),
    ]);

    for (const resource of [existingPhone, existingAssistant]) {
      if (resource && (
        resource.organizationId !== options.organizationId ||
        resource.providerAccountId !== account.id
      )) {
        throw new Error('A Vapi resource is already assigned to another tenant or account');
      }
    }
    if (!existingPhone && phoneCount >= phoneCap) {
      throw new Error('The organization has reached its platform Vapi phone-number cap');
    }
    if (!existingAssistant && assistantCount >= assistantCap) {
      throw new Error('The organization has reached its platform Vapi assistant cap');
    }

    const assistantClinicId = options.assistantScope === 'clinic' ? options.clinicId : null;
    if (existingPhone?.status === 'active' && existingPhone.clinicId !== options.clinicId) {
      throw new Error('Deactivate the phone resource before moving it to another clinic');
    }
    if (existingAssistant?.status === 'active' && existingAssistant.clinicId !== assistantClinicId) {
      throw new Error('Deactivate the assistant before changing its clinic scope');
    }
    const phoneStatus = options.activate ? 'active' : existingPhone?.status ?? 'provisioning';
    const assistantStatus = options.activate ? 'active' : existingAssistant?.status ?? 'provisioning';

    const phoneResource = existingPhone
      ? await tx.providerResource.update({
          where: { id: existingPhone.id },
          data: {
            clinicId: options.clinicId,
            displayName: options.phoneDisplayName ?? existingPhone.displayName,
            status: phoneStatus,
            config: {
              direction: 'both',
              inboundAssistantId: assistant.id,
              admissionVerifiedAt: new Date().toISOString(),
            },
          },
        })
      : await tx.providerResource.create({
          data: {
            organizationId: options.organizationId,
            clinicId: options.clinicId,
            providerAccountId: account.id,
            provider: 'vapi',
            resourceType: 'phone_number',
            externalId: phone.id,
            displayName: options.phoneDisplayName,
            status: phoneStatus,
            config: {
              direction: 'both',
              inboundAssistantId: assistant.id,
              admissionVerifiedAt: new Date().toISOString(),
            },
          },
        });
    const assistantResource = existingAssistant
      ? await tx.providerResource.update({
          where: { id: existingAssistant.id },
          data: {
            clinicId: assistantClinicId,
            displayName: options.assistantDisplayName ?? existingAssistant.displayName,
            status: assistantStatus,
            config: { purpose: 'receptionist' },
          },
        })
      : await tx.providerResource.create({
          data: {
            organizationId: options.organizationId,
            clinicId: assistantClinicId,
            providerAccountId: account.id,
            provider: 'vapi',
            resourceType: 'assistant',
            externalId: assistant.id,
            displayName: options.assistantDisplayName,
            status: assistantStatus,
            config: { purpose: 'receptionist' },
          },
        });

    await tx.auditLog.create({
      data: {
        organizationId: options.organizationId,
        clinicId: options.clinicId,
        action: 'provider.platform_vapi_bound',
        targetType: 'ProviderAccount',
        targetId: account.id,
        metadata: {
          source: 'operator_cli',
          status: accountStatus,
          phoneResourceId: phoneResource.id,
          assistantResourceId: assistantResource.id,
          assistantScope: options.assistantScope,
        },
      },
    });

    return {
      accountId: account.id,
      phoneResourceId: phoneResource.id,
      assistantResourceId: assistantResource.id,
      status: accountStatus,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  console.log('Platform-funded Vapi resources bound', result);
}

main()
  .catch((error) => {
    console.error('Platform-funded Vapi provisioning failed', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown error',
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
