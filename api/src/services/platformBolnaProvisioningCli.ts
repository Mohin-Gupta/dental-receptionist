/**
 * Operator CLI that binds an existing Bolna agent + phone number to a
 * clinic/organization, mirroring platformVapiProvisioningCli.ts. Simpler
 * than the Vapi equivalent in one respect and different in another:
 *
 *  - Simpler: Bolna's API key is already account-scoped (unlike Vapi's
 *    platform key, which can see multiple provider organizations), so there
 *    is no cross-organization ownership proof to run — confirming the agent
 *    is visible with our credentials at all is sufficient.
 *  - Different: POST /inbound/setup is not just a verification step, it is
 *    what actually makes Bolna route calls on this number to this agent —
 *    unlike Vapi, there is no separate live per-call assistant-selection
 *    step, so this one call *is* the entire routing decision.
 *
 * The phone number itself must already exist in Bolna's own inventory
 * (surfaced there via the one-time Vobiz "Providers" link done once in the
 * Bolna dashboard — see DEPLOYMENT.md) before this can bind it.
 *
 * Usage:
 *   npm run bolna:bind-platform -- \
 *     --organization-id <uuid> \
 *     --clinic-id <uuid> \
 *     --agent-id <bolna-agent-id> \
 *     --bolna-phone-number-id <bolna-internal-phone-id> \
 *     --phone-number +91XXXXXXXXXX \
 *     --phone-display-name "Sunrise Dental main line" \
 *     --activate --confirm
 */
import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getBolnaAgent, setBolnaInboundAgent } from './bolnaClient';

const valueFlags = new Set([
  '--organization-id',
  '--clinic-id',
  '--agent-id',
  '--bolna-phone-number-id',
  '--phone-number',
  '--phone-display-name',
]);
const booleanFlags = new Set(['--activate', '--confirm']);

const e164 = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Phone number must use E.164 format');

const optionsSchema = z.object({
  organizationId: z.string().uuid(),
  clinicId: z.string().uuid(),
  agentId: z.string().trim().min(1).max(200),
  bolnaPhoneNumberId: z.string().trim().min(1).max(200),
  phoneNumber: e164,
  phoneDisplayName: z.string().trim().min(1).max(160).optional(),
  activate: z.boolean(),
  confirm: z.literal(true),
}).strict();

type Options = z.infer<typeof optionsSchema>;

function camelCaseFlag(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function parseArguments(argv: string[]): Options {
  const values: Record<string, string | boolean> = { activate: false, confirm: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (booleanFlags.has(flag)) {
      values[camelCaseFlag(flag)] = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values[camelCaseFlag(flag)] = value;
    index += 1;
  }
  return optionsSchema.parse(values);
}

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const phoneCap = configuredInteger('PLATFORM_BOLNA_MAX_PHONE_NUMBERS_PER_ORGANIZATION', 10, 1, 100);

  const [organization, clinic] = await Promise.all([
    prisma.organization.findUnique({ where: { id: options.organizationId }, select: { id: true, status: true } }),
    prisma.clinic.findFirst({
      where: { id: options.clinicId, organizationId: options.organizationId, status: 'active' },
      select: { id: true },
    }),
  ]);
  if (!organization) throw new Error('Organization not found');
  if (!clinic) throw new Error('Clinic is not active in the organization');
  if (options.activate && organization.status !== 'active') {
    throw new Error('The organization must be active before Bolna resources can be activated');
  }

  // Confirms the agent exists and is visible with our platform credentials.
  const agent = await getBolnaAgent(options.agentId);
  const returnedAgentId = agent.agent_id ?? agent.id;
  if (returnedAgentId !== options.agentId) {
    throw new Error('Bolna returned a mismatched agent id');
  }

  // This is what actually makes Bolna route calls on this number to this
  // agent — see file header. Done before the local transaction so we never
  // record a binding locally that Bolna itself rejected.
  await setBolnaInboundAgent({ agentId: options.agentId, phoneNumberId: options.bolnaPhoneNumberId });

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform-bolna:${options.organizationId}`}))`;

    const externalAccountId = `platform:${options.organizationId}`;
    const existingAccount = await tx.providerAccount.findUnique({
      where: { organizationId_provider: { organizationId: options.organizationId, provider: 'bolna' } },
    });
    const accountStatus = options.activate ? 'active' : existingAccount?.status ?? 'provisioning';
    const account = existingAccount
      ? await tx.providerAccount.update({
          where: { id: existingAccount.id },
          data: { externalAccountId, status: accountStatus, config: { credentialSource: 'platform' } },
        })
      : await tx.providerAccount.create({
          data: {
            organizationId: options.organizationId,
            provider: 'bolna',
            externalAccountId,
            status: accountStatus,
            config: { credentialSource: 'platform' },
          },
        });

    const existingPhone = await tx.providerResource.findUnique({
      where: {
        provider_resourceType_externalId: {
          provider: 'bolna',
          resourceType: 'phone_number',
          externalId: options.phoneNumber,
        },
      },
    });
    if (existingPhone && (existingPhone.organizationId !== options.organizationId || existingPhone.providerAccountId !== account.id)) {
      throw new Error('This phone number is already bound to another tenant or account');
    }
    const phoneCount = await tx.providerResource.count({
      where: { organizationId: options.organizationId, provider: 'bolna', resourceType: 'phone_number' },
    });
    if (!existingPhone && phoneCount >= phoneCap) {
      throw new Error('The organization has reached its platform Bolna phone-number cap');
    }

    const phoneStatus = options.activate ? 'active' : existingPhone?.status ?? 'provisioning';
    const phoneConfig = {
      agentId: options.agentId,
      bolnaPhoneNumberId: options.bolnaPhoneNumberId,
      boundAt: new Date().toISOString(),
    };
    const phoneResource = existingPhone
      ? await tx.providerResource.update({
          where: { id: existingPhone.id },
          data: {
            clinicId: options.clinicId,
            displayName: options.phoneDisplayName ?? existingPhone.displayName,
            status: phoneStatus,
            config: phoneConfig,
          },
        })
      : await tx.providerResource.create({
          data: {
            organizationId: options.organizationId,
            clinicId: options.clinicId,
            providerAccountId: account.id,
            provider: 'bolna',
            resourceType: 'phone_number',
            externalId: options.phoneNumber,
            displayName: options.phoneDisplayName,
            status: phoneStatus,
            config: phoneConfig,
          },
        });

    await tx.auditLog.create({
      data: {
        organizationId: options.organizationId,
        clinicId: options.clinicId,
        action: 'provider.platform_bolna_bound',
        targetType: 'ProviderAccount',
        targetId: account.id,
        metadata: {
          source: 'operator_cli',
          status: accountStatus,
          phoneResourceId: phoneResource.id,
          agentId: options.agentId,
        },
      },
    });

    return { accountId: account.id, phoneResourceId: phoneResource.id, status: accountStatus };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  console.log('Platform-funded Bolna resources bound', result);
}

main()
  .catch((error) => {
    console.error('Platform-funded Bolna provisioning failed', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown error',
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
