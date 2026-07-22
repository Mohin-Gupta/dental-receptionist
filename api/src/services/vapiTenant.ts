import { Prisma, type CommunicationAttempt, type ProviderResource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { extractDirectionAndPhone } from '../lib/vapiPayloadHelpers';

export class VapiTenantResolutionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface ResolvedVapiTenant {
  callId: string;
  organizationId: string;
  clinicId: string;
  defaultCallingCode: string;
  organizationStatus: string;
  inboundAssistantId: string | null;
  resource: ProviderResource;
  attempt: CommunicationAttempt;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function extractVapiCallId(message: any): string | null {
  return nonEmptyString(message?.call?.id) ?? nonEmptyString(message?.callId);
}

/**
 * Vapi documents phoneNumber as trusted server metadata. Never accept a clinic
 * or organization ID from tool arguments or conversation-derived variables.
 */
export function extractVapiPhoneNumberId(message: any): string | null {
  return (
    nonEmptyString(message?.phoneNumber?.id) ??
    nonEmptyString(message?.phoneNumberId) ??
    nonEmptyString(message?.call?.phoneNumber?.id) ??
    nonEmptyString(message?.call?.phoneNumberId)
  );
}

async function resolveInboundAssistant(resource: ProviderResource): Promise<string | null> {
  const config = resource.config && typeof resource.config === 'object' && !Array.isArray(resource.config)
    ? resource.config as Record<string, unknown>
    : {};
  const direction = typeof config.direction === 'string' ? config.direction : 'both';
  if (
    direction === 'outbound' ||
    typeof config.inboundAssistantId !== 'string' ||
    typeof config.admissionVerifiedAt !== 'string' ||
    Number.isNaN(new Date(config.admissionVerifiedAt).getTime())
  ) return null;
  const assistant = await prisma.providerResource.findUnique({
    where: {
      provider_resourceType_externalId: {
        provider: 'vapi',
        resourceType: 'assistant',
        externalId: config.inboundAssistantId,
      },
    },
    select: {
      externalId: true,
      organizationId: true,
      providerAccountId: true,
      clinicId: true,
      status: true,
    },
  });
  if (
    !assistant ||
    assistant.organizationId !== resource.organizationId ||
    assistant.providerAccountId !== resource.providerAccountId ||
    assistant.status !== 'active' ||
    (assistant.clinicId !== null && assistant.clinicId !== resource.clinicId)
  ) return null;
  return assistant.externalId;
}

export async function resolveVapiTenant(
  message: any,
  options: { allowInactiveForTerminalAccounting?: boolean } = {}
): Promise<ResolvedVapiTenant> {
  const callId = extractVapiCallId(message);
  if (!callId) {
    throw new VapiTenantResolutionError('A stable Vapi call ID is required', 'missing_call_id');
  }

  // Outbound calls are registered before the provider request is made, so the
  // provider call ID is the strongest way to recover their tenant attribution.
  const existingAttempt = await prisma.communicationAttempt.findFirst({
    where: { provider: 'vapi', externalId: callId },
    include: {
      clinic: true,
      organization: { select: { status: true } },
      providerResource: {
        include: { providerAccount: { select: { status: true } } },
      },
    },
  });

  if (existingAttempt) {
    if (!existingAttempt.clinicId || !existingAttempt.clinic || !existingAttempt.providerResource) {
      throw new VapiTenantResolutionError(
        'The outbound call is missing its clinic or provider-resource attribution',
        'incomplete_outbound_attribution'
      );
    }
    if (
      !options.allowInactiveForTerminalAccounting &&
      existingAttempt.clinic.status !== 'active'
    ) {
      throw new VapiTenantResolutionError('The clinic is not active', 'clinic_inactive');
    }
    if (
      !options.allowInactiveForTerminalAccounting &&
      (
        existingAttempt.providerResource.status !== 'active' ||
        existingAttempt.providerResource.providerAccount.status !== 'active'
      )
    ) {
      throw new VapiTenantResolutionError(
        'The provider account or resource is not active',
        'provider_inactive'
      );
    }
    return {
      callId,
      organizationId: existingAttempt.organizationId,
      clinicId: existingAttempt.clinicId,
      defaultCallingCode: existingAttempt.clinic.defaultCallingCode,
      organizationStatus: existingAttempt.organization.status,
      inboundAssistantId: options.allowInactiveForTerminalAccounting
        ? null
        : await resolveInboundAssistant(existingAttempt.providerResource),
      resource: existingAttempt.providerResource,
      attempt: existingAttempt,
    };
  }

  const phoneNumberId = extractVapiPhoneNumberId(message);
  if (!phoneNumberId) {
    throw new VapiTenantResolutionError(
      'Vapi phone-number metadata is required to resolve the tenant',
      'missing_phone_number_id'
    );
  }

  const resource = await prisma.providerResource.findUnique({
    where: {
      provider_resourceType_externalId: {
        provider: 'vapi',
        resourceType: 'phone_number',
        externalId: phoneNumberId,
      },
    },
    include: {
      clinic: true,
      organization: { select: { status: true } },
      providerAccount: { select: { status: true } },
    },
  });

  if (!resource || !resource.clinicId || !resource.clinic) {
    throw new VapiTenantResolutionError(
      'No active clinic mapping exists for this Vapi phone number',
      'unmapped_phone_number'
    );
  }
  if (!options.allowInactiveForTerminalAccounting && resource.clinic.status !== 'active') {
    throw new VapiTenantResolutionError('The clinic is not active', 'clinic_inactive');
  }
  if (!options.allowInactiveForTerminalAccounting && resource.status !== 'active') {
    throw new VapiTenantResolutionError('The provider resource is not active', 'resource_inactive');
  }
  if (!options.allowInactiveForTerminalAccounting && resource.providerAccount.status !== 'active') {
    throw new VapiTenantResolutionError('The provider account is not active', 'provider_inactive');
  }
  const { direction, phoneNumber } = extractDirectionAndPhone(message);
  const idempotencyKey = `vapi:call:${callId}`;
  let attempt: CommunicationAttempt;
  try {
    attempt = await prisma.communicationAttempt.create({
      data: {
        organizationId: resource.organizationId,
        clinicId: resource.clinicId,
        providerResourceId: resource.id,
        provider: 'vapi',
        channel: 'voice',
        direction,
        externalId: callId,
        idempotencyKey,
        status: 'in_progress',
        destination: direction === 'outbound' ? phoneNumber : resource.displayName,
        origin: direction === 'inbound' ? phoneNumber : resource.displayName,
        startedAt: validDate(message?.call?.startedAt),
        request: { eventType: String(message?.type ?? 'unknown') },
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    attempt = await prisma.communicationAttempt.findFirstOrThrow({
      where: {
        organizationId: resource.organizationId,
        provider: 'vapi',
        externalId: callId,
      },
    });
  }

  return {
    callId,
    organizationId: resource.organizationId,
    clinicId: resource.clinicId,
    defaultCallingCode: resource.clinic.defaultCallingCode,
    organizationStatus: resource.organization.status,
    inboundAssistantId: options.allowInactiveForTerminalAccounting
      ? null
      : await resolveInboundAssistant(resource),
    resource,
    attempt,
  };
}
