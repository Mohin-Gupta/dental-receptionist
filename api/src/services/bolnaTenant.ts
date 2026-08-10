/**
 * Tenant resolution for Bolna calls. Mirrors vapiTenant.ts's role, but is
 * structurally simpler: Bolna's inbound routing is static — a phone number
 * is bound to exactly one agent once, via POST /inbound/setup (see
 * platformBolnaProvisioningCli.ts) — not resolved per call the way Vapi's
 * assistant-request webhook works. There is therefore no per-call "which
 * agent should answer this" decision to make here; this only needs to
 * recover which organization/clinic a given to_number/call_sid belongs to,
 * for data scoping, commercial gating, and billing.
 */
import { Prisma, type CommunicationAttempt, type ProviderResource } from '@prisma/client';
import { prisma } from '../lib/prisma';

export class BolnaTenantResolutionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface ResolvedBolnaTenant {
  callId: string;
  organizationId: string;
  clinicId: string;
  defaultCallingCode: string;
  organizationStatus: string;
  resource: ProviderResource;
  attempt: CommunicationAttempt;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function resolveBolnaTenant(input: {
  callId: string;
  toNumber: string | null;
  fromNumber?: string | null;
  options?: { allowInactiveForTerminalAccounting?: boolean };
}): Promise<ResolvedBolnaTenant> {
  const callId = nonEmptyString(input.callId);
  if (!callId) {
    throw new BolnaTenantResolutionError('A stable Bolna call_sid is required', 'missing_call_id');
  }
  const allowInactive = input.options?.allowInactiveForTerminalAccounting ?? false;

  const existingAttempt = await prisma.communicationAttempt.findFirst({
    where: { provider: 'bolna', externalId: callId },
    include: {
      clinic: true,
      organization: { select: { status: true } },
      providerResource: { include: { providerAccount: { select: { status: true } } } },
    },
  });

  if (existingAttempt) {
    if (!existingAttempt.clinicId || !existingAttempt.clinic || !existingAttempt.providerResource) {
      throw new BolnaTenantResolutionError(
        'The call is missing its clinic or provider-resource attribution',
        'incomplete_attribution'
      );
    }
    if (!allowInactive && existingAttempt.clinic.status !== 'active') {
      throw new BolnaTenantResolutionError('The clinic is not active', 'clinic_inactive');
    }
    if (
      !allowInactive &&
      (existingAttempt.providerResource.status !== 'active' ||
        existingAttempt.providerResource.providerAccount.status !== 'active')
    ) {
      throw new BolnaTenantResolutionError('The provider account or resource is not active', 'provider_inactive');
    }
    return {
      callId,
      organizationId: existingAttempt.organizationId,
      clinicId: existingAttempt.clinicId,
      defaultCallingCode: existingAttempt.clinic.defaultCallingCode,
      organizationStatus: existingAttempt.organization.status,
      resource: existingAttempt.providerResource,
      attempt: existingAttempt,
    };
  }

  // No existing attempt: this is the first time we're seeing this call_sid,
  // which for an inbound call means the first tool invocation of the call
  // (Bolna has no pre-connection gating webhook the way Vapi's
  // assistant-request works — see the commercial-access note in
  // bolna.webhook.ts). Resolve the clinic from to_number and create it now.
  const toNumber = nonEmptyString(input.toNumber);
  if (!toNumber) {
    throw new BolnaTenantResolutionError(
      'The Bolna to_number system value is required to resolve a new call',
      'missing_to_number'
    );
  }

  const resource = await prisma.providerResource.findUnique({
    where: {
      provider_resourceType_externalId: {
        provider: 'bolna',
        resourceType: 'phone_number',
        externalId: toNumber,
      },
    },
    include: {
      clinic: true,
      organization: { select: { status: true } },
      providerAccount: { select: { status: true } },
    },
  });

  if (!resource || !resource.clinicId || !resource.clinic) {
    throw new BolnaTenantResolutionError('No clinic mapping exists for this Bolna phone number', 'unmapped_phone_number');
  }
  if (!allowInactive && resource.clinic.status !== 'active') {
    throw new BolnaTenantResolutionError('The clinic is not active', 'clinic_inactive');
  }
  if (!allowInactive && resource.status !== 'active') {
    throw new BolnaTenantResolutionError('The provider resource is not active', 'resource_inactive');
  }
  if (!allowInactive && resource.providerAccount.status !== 'active') {
    throw new BolnaTenantResolutionError('The provider account is not active', 'provider_inactive');
  }

  const fromNumber = nonEmptyString(input.fromNumber);
  const idempotencyKey = `bolna:call:${callId}`;

  let attempt: CommunicationAttempt;
  try {
    attempt = await prisma.communicationAttempt.create({
      data: {
        organizationId: resource.organizationId,
        clinicId: resource.clinicId,
        providerResourceId: resource.id,
        provider: 'bolna',
        channel: 'voice',
        direction: 'inbound',
        externalId: callId,
        idempotencyKey,
        status: 'in_progress',
        // Matches vapiTenant.ts's inbound convention: origin is the caller's
        // number, destination represents the clinic side that was dialled.
        origin: fromNumber ?? undefined,
        destination: resource.displayName ?? toNumber,
        startedAt: new Date(),
        request: { source: 'bolna_tool_call', toNumber },
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    // Another concurrent tool call for the same fresh call_sid won the race.
    attempt = await prisma.communicationAttempt.findFirstOrThrow({
      where: { organizationId: resource.organizationId, provider: 'bolna', externalId: callId },
    });
  }

  return {
    callId,
    organizationId: resource.organizationId,
    clinicId: resource.clinicId,
    defaultCallingCode: resource.clinic.defaultCallingCode,
    organizationStatus: resource.organization.status,
    resource,
    attempt,
  };
}
