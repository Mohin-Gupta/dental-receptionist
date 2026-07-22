import { Prisma, type ProviderAccount, type ProviderResource } from '@prisma/client';
import { type Request, type Response } from 'express';
import { z } from 'zod';
import { auditAction } from '../../auth/audit';
import {
  requireMfaForSensitiveAction,
  requireOrganizationOwner,
  requirePermission,
} from '../../auth/middleware';
import { prisma } from '../../lib/prisma';
import {
  credentialRotationSchema,
  encryptProviderCredentials,
  isPlatformManagedVapiAccount,
  parseAccountConfig,
  parseExternalAccountId,
  parseResourceConfig,
  parseResourceExternalId,
  providerCredentialSource,
  providerAccountCreateSchema,
  providerAccountReadinessIssues,
  providerAccountUpdateSchema,
  providerEntityIdSchema,
  ProviderOwnershipVerificationError,
  providerResourceCreateSchema,
  providerResourceUpdateSchema,
  providerSchema,
  publicAccountConfig,
  publicResourceConfig,
  type SupportedProvider,
  verifyProviderResourceOwnership,
  verifyProviderAccountCredentials,
  verifyVapiReceptionistConfiguration,
} from '../../services/providerProvisioning';
import { getVapiInboundReservationSeconds } from '../../services/vapiOutbound';
import { createRouter } from '../../lib/asyncRouter';

const router = createRouter();
const manageIntegration = [
  requirePermission('integrations:manage'),
  requireOrganizationOwner,
  requireMfaForSensitiveAction,
] as const;

type AccountForResponse = Pick<
  ProviderAccount,
  | 'id'
  | 'organizationId'
  | 'provider'
  | 'externalAccountId'
  | 'status'
  | 'credentialsEncrypted'
  | 'config'
  | 'createdAt'
  | 'updatedAt'
>;

type ResourceForResponse = Pick<
  ProviderResource,
  | 'id'
  | 'organizationId'
  | 'clinicId'
  | 'providerAccountId'
  | 'provider'
  | 'resourceType'
  | 'externalId'
  | 'displayName'
  | 'status'
  | 'config'
  | 'createdAt'
  | 'updatedAt'
>;

function safeAccount(account: AccountForResponse) {
  const platformManaged = isPlatformManagedVapiAccount(account);
  return {
    id: account.id,
    organizationId: account.organizationId,
    provider: account.provider,
    externalAccountId: account.externalAccountId,
    status: account.status,
    hasCredentials: platformManaged
      ? process.env.PLATFORM_VAPI_ENABLED === 'true' && Boolean(process.env.PLATFORM_VAPI_API_KEY?.trim())
      : Boolean(account.credentialsEncrypted),
    credentialSource: platformManaged ? 'platform' : 'tenant',
    config: publicAccountConfig(account.provider, account.config),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function safeResource(resource: ResourceForResponse) {
  return {
    id: resource.id,
    organizationId: resource.organizationId,
    clinicId: resource.clinicId,
    providerAccountId: resource.providerAccountId,
    provider: resource.provider,
    resourceType: resource.resourceType,
    externalId: resource.externalId,
    displayName: resource.displayName,
    status: resource.status,
    config: publicResourceConfig(
      resource.provider,
      resource.resourceType,
      resource.config
    ),
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function invalidRequest(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid integration data' });
  }
  return res.status(400).json({
    error: error instanceof Error ? error.message : 'Invalid integration data',
  });
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function ownershipErrorResponse(res: Response, error: ProviderOwnershipVerificationError) {
  if (error.reason === 'provider_unavailable') {
    return res.status(503).json({ error: error.message });
  }
  return res.status(422).json({ error: error.message });
}

async function organizationStatus(organizationId: string): Promise<string | null> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { status: true },
  });
  return organization?.status ?? null;
}

async function verifyClinicOwnership(
  organizationId: string,
  clinicId: string | null | undefined
): Promise<boolean> {
  if (clinicId === null || clinicId === undefined) return true;
  const clinic = await prisma.clinic.findFirst({
    where: { id: clinicId, organizationId, status: 'active' },
    select: { id: true },
  });
  return Boolean(clinic);
}

async function externalAccountIdAvailable(
  provider: SupportedProvider,
  externalAccountId: string,
  currentId?: string
): Promise<boolean> {
  const existing = await prisma.providerAccount.findUnique({
    where: { provider_externalAccountId: { provider, externalAccountId } },
    select: { id: true },
  });
  return !existing || existing.id === currentId;
}

async function externalResourceIdAvailable(
  provider: SupportedProvider,
  resourceType: string,
  externalId: string,
  currentId?: string
): Promise<boolean> {
  const existing = await prisma.providerResource.findUnique({
    where: {
      provider_resourceType_externalId: { provider, resourceType, externalId },
    },
    select: { id: true },
  });
  return !existing || existing.id === currentId;
}

function accountReadinessError(account: Parameters<typeof providerAccountReadinessIssues>[0]) {
  const issues = providerAccountReadinessIssues(account);
  return issues.length ? issues.join('; ') : null;
}

async function requireActiveOrganizationForActivation(
  res: Response,
  organizationId: string
): Promise<boolean> {
  const status = await organizationStatus(organizationId);
  if (!status) {
    res.status(404).json({ error: 'Organization not found' });
    return false;
  }
  if (status !== 'active') {
    res.status(409).json({ error: 'The organization must be active before an integration can be activated' });
    return false;
  }
  return true;
}

async function vapiInboundAssistantMappingIssue(input: {
  providerAccountId: string;
  clinicId: string | null | undefined;
  config: unknown;
}): Promise<string | null> {
  const config = parseResourceConfig('vapi', 'phone_number', input.config);
  const direction = typeof config.direction === 'string' ? config.direction : 'both';
  if (direction === 'outbound') return null;
  const inboundAssistantId = typeof config.inboundAssistantId === 'string'
    ? config.inboundAssistantId
    : null;
  if (!inboundAssistantId) return 'Inbound Vapi phone numbers require a mapped receptionist assistant';
  const assistant = await prisma.providerResource.findUnique({
    where: {
      provider_resourceType_externalId: {
        provider: 'vapi',
        resourceType: 'assistant',
        externalId: inboundAssistantId,
      },
    },
    select: { providerAccountId: true, clinicId: true, status: true },
  });
  if (
    !assistant ||
    assistant.providerAccountId !== input.providerAccountId ||
    assistant.status !== 'active' ||
    (assistant.clinicId !== null && assistant.clinicId !== input.clinicId)
  ) {
    return 'The mapped inbound Vapi assistant must be active in the same account and clinic scope';
  }
  return null;
}

async function activeInboundPhonesUsingAssistant(input: {
  providerAccountId: string;
  assistantId: string;
}): Promise<string[]> {
  const phones = await prisma.providerResource.findMany({
    where: {
      providerAccountId: input.providerAccountId,
      provider: 'vapi',
      resourceType: 'phone_number',
      status: 'active',
    },
    select: { id: true, config: true },
  });
  return phones.flatMap(phone => {
    try {
      const config = parseResourceConfig('vapi', 'phone_number', phone.config);
      return config.direction !== 'outbound' && config.inboundAssistantId === input.assistantId
        ? [phone.id]
        : [];
    } catch {
      // Corrupt active phone configuration is already fail-closed by tenant
      // resolution; keep it attached so an assistant cannot mask the issue.
      return [];
    }
  });
}

function vapiPhoneAcceptsInbound(config: unknown): boolean {
  const parsed = parseResourceConfig('vapi', 'phone_number', config);
  return parsed.direction !== 'outbound';
}

function productionVapiActivationIssue(account: Pick<
  ProviderAccount,
  'organizationId' | 'provider' | 'externalAccountId' | 'config'
>): string | null {
  if (
    process.env.NODE_ENV === 'production' &&
    account.provider === 'vapi' &&
    !isPlatformManagedVapiAccount(account)
  ) {
    return 'Production Vapi resources must be provisioned through the platform-managed operator flow';
  }
  return null;
}

function vapiAdmissionVerificationIssue(config: unknown): string | null {
  const parsed = parseResourceConfig('vapi', 'phone_number', config);
  if (parsed.direction === 'outbound') return null;
  if (
    typeof parsed.admissionVerifiedAt !== 'string' ||
    Number.isNaN(new Date(parsed.admissionVerifiedAt).getTime())
  ) {
    return 'Inbound admission has not been verified against the live Vapi phone configuration';
  }
  return null;
}

async function verifyActiveProviderResources(
  account: Pick<
    ProviderAccount,
    'organizationId' | 'provider' | 'externalAccountId' | 'credentialsEncrypted' | 'config'
  >,
  resources: Array<Pick<
    ProviderResource,
    'id' | 'providerAccountId' | 'clinicId' | 'provider' | 'resourceType' | 'externalId' | 'config'
  >>
): Promise<Array<{ id: string; config: Record<string, unknown> }>> {
  const activationIssue = productionVapiActivationIssue(account);
  if (activationIssue && resources.some(resource => resource.provider === 'vapi')) {
    throw new Error(activationIssue);
  }
  const admissionUpdates: Array<{ id: string; config: Record<string, unknown> }> = [];
  for (const resource of resources) {
    await verifyProviderResourceOwnership(account, resource);
    if (
      resource.provider !== 'vapi' ||
      resource.resourceType !== 'phone_number' ||
      !vapiPhoneAcceptsInbound(resource.config)
    ) continue;

    const issue = await vapiInboundAssistantMappingIssue({
      providerAccountId: resource.providerAccountId,
      clinicId: resource.clinicId,
      config: resource.config,
    });
    if (issue) throw new Error(issue);
    const phoneConfig = parseResourceConfig('vapi', 'phone_number', resource.config);
    await verifyVapiReceptionistConfiguration(account, {
      phoneNumberId: resource.externalId,
      assistantId: String(phoneConfig.inboundAssistantId),
      expectedMaxDurationSeconds: getVapiInboundReservationSeconds(),
    });
    admissionUpdates.push({
      id: resource.id,
      config: {
        ...parseResourceConfig('vapi', 'phone_number', resource.config),
        admissionVerifiedAt: new Date().toISOString(),
      },
    });
  }
  return admissionUpdates;
}

router.get(
  '/dashboard/integrations',
  requirePermission('integrations:manage'),
  requireOrganizationOwner,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const accounts = await prisma.providerAccount.findMany({
      where: { organizationId },
      include: { resources: { orderBy: { createdAt: 'asc' } } },
      orderBy: { provider: 'asc' },
    });

    res.json({
      accounts: accounts.map(account => ({
        ...safeAccount(account),
        resources: account.resources.map(safeResource),
      })),
    });
  }
);

router.get(
  '/dashboard/integrations/health',
  requirePermission('integrations:manage'),
  requireOrganizationOwner,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const [status, accounts, resources] = await Promise.all([
      organizationStatus(organizationId),
      prisma.providerAccount.findMany({ where: { organizationId } }),
      prisma.providerResource.findMany({ where: { organizationId } }),
    ]);

    const accountById = new Map(accounts.map(account => [account.id, account]));
    const accountHealth = accounts.map(account => {
      const issues = providerAccountReadinessIssues(account);
      if (account.status !== 'active') issues.push('Account is not active');
      if (
        productionVapiActivationIssue(account) &&
        resources.some(resource => resource.providerAccountId === account.id && resource.status === 'active')
      ) {
        issues.push('Tenant-owned Vapi resources are disabled in production; use platform provisioning');
      }
      return {
        id: account.id,
        provider: account.provider,
        status: account.status,
        configured: issues.length === 0,
        issues,
      };
    });

    const resourceHealth = resources.map(resource => {
      const issues: string[] = [];
      const account = accountById.get(resource.providerAccountId);
      const provider = providerSchema.safeParse(resource.provider);
      if (!provider.success) issues.push('Unsupported provider');
      if (!account || account.organizationId !== organizationId) {
        issues.push('Provider account is missing');
      } else {
        if (account.provider !== resource.provider) issues.push('Provider account does not match resource');
        if (account.status !== 'active') issues.push('Provider account is not active');
      }
      if (provider.success) {
        try {
          parseResourceExternalId(provider.data, resource.resourceType, resource.externalId);
        } catch {
          issues.push('External resource identifier is invalid');
        }
        try {
          parseResourceConfig(provider.data, resource.resourceType, resource.config);
        } catch {
          issues.push('Resource configuration is invalid');
        }
      }
      if (resource.provider === 'vapi' && resource.resourceType === 'phone_number' && !resource.clinicId) {
        issues.push('A Vapi phone number must be assigned to a clinic');
      }
      if (resource.provider === 'vapi' && resource.resourceType === 'phone_number') {
        try {
          const config = parseResourceConfig('vapi', 'phone_number', resource.config);
          const direction = typeof config.direction === 'string' ? config.direction : 'both';
          const inboundAssistantId = typeof config.inboundAssistantId === 'string'
            ? config.inboundAssistantId
            : null;
          if (direction !== 'outbound' && !resources.some(candidate =>
            candidate.provider === 'vapi' &&
            candidate.resourceType === 'assistant' &&
            candidate.externalId === inboundAssistantId &&
            candidate.providerAccountId === resource.providerAccountId &&
            candidate.status === 'active' &&
            (candidate.clinicId === resource.clinicId || candidate.clinicId === null)
          )) {
            issues.push('The configured inbound Vapi assistant is not active in this account and clinic scope');
          }
          const admissionIssue = vapiAdmissionVerificationIssue(config);
          if (admissionIssue) issues.push(admissionIssue);
        } catch {
          // The generic configuration issue above is sufficient and avoids
          // turning a corrupted provider row into a health-endpoint failure.
        }
      }
      if (resource.status !== 'active') issues.push('Resource is not active');
      if (account && resource.status === 'active') {
        const activationIssue = productionVapiActivationIssue(account);
        if (activationIssue) issues.push(activationIssue);
      }

      return {
        id: resource.id,
        provider: resource.provider,
        resourceType: resource.resourceType,
        clinicId: resource.clinicId,
        status: resource.status,
        configured: issues.length === 0,
        issues,
      };
    });

    res.json({
      scope: 'configuration_only',
      organizationStatus: status,
      healthy:
        status === 'active' &&
        accountHealth.length > 0 &&
        accountHealth.every(item => item.configured) &&
        resourceHealth.length > 0 &&
        resourceHealth.every(item => item.configured),
      accounts: accountHealth,
      resources: resourceHealth,
    });
  }
);

router.post(
  '/dashboard/integrations/accounts',
  ...manageIntegration,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const parsed = providerAccountCreateSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const body = parsed.data;

    if (body.provider === 'vapi' && body.config?.credentialSource === 'platform') {
      return res.status(403).json({
        error: 'Platform-funded Vapi accounts can only be provisioned by the service operator',
      });
    }

    let externalAccountId: string;
    let encrypted: ReturnType<typeof encryptProviderCredentials>;
    try {
      externalAccountId = await verifyProviderAccountCredentials(
        body.provider,
        body.externalAccountId,
        body.credentials
      );
      encrypted = encryptProviderCredentials(
        organizationId,
        body.provider,
        externalAccountId,
        body.credentials
      );
    } catch (error) {
      if (error instanceof ProviderOwnershipVerificationError) {
        return ownershipErrorResponse(res, error);
      }
      return invalidRequest(res, error);
    }

    const sameProvider = await prisma.providerAccount.findUnique({
      where: { organizationId_provider: { organizationId, provider: body.provider } },
      select: { id: true },
    });
    if (sameProvider) {
      return res.status(409).json({ error: 'This organization already has an account for that provider' });
    }
    if (!(await externalAccountIdAvailable(body.provider, externalAccountId))) {
      return res.status(409).json({ error: 'That external account is already assigned' });
    }

    if (body.status === 'active') {
      if (!(await requireActiveOrganizationForActivation(res, organizationId))) return;
      const readinessError = accountReadinessError({
        organizationId,
        provider: body.provider,
        externalAccountId,
        credentialsEncrypted: encrypted.credentialsEncrypted,
        config: body.config ?? {},
      });
      if (readinessError) return res.status(422).json({ error: readinessError });
    }

    try {
      const account = await prisma.providerAccount.create({
        data: {
          organizationId,
          provider: body.provider,
          externalAccountId,
          status: body.status,
          credentialsEncrypted: encrypted.credentialsEncrypted,
          credentialKeyVersion: encrypted.credentialKeyVersion,
          config: body.config as Prisma.InputJsonValue | undefined,
        },
      });
      await auditAction(req, 'provider_account.created', {
        organizationId,
        targetType: 'ProviderAccount',
        targetId: account.id,
        metadata: {
          provider: account.provider,
          status: account.status,
          credentialsConfigured: true,
        },
      });
      return res.status(201).json({ account: safeAccount(account) });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return res.status(409).json({ error: 'Provider account assignment conflicts with an existing account' });
      }
      throw error;
    }
  }
);

router.patch(
  '/dashboard/integrations/accounts/:id',
  ...manageIntegration,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const parsedId = providerEntityIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid provider account ID' });
    const parsed = providerAccountUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);

    const existing = await prisma.providerAccount.findFirst({
      where: { id: parsedId.data, organizationId },
      include: { resources: { where: { status: 'active' } } },
    });
    if (!existing) return res.status(404).json({ error: 'Provider account not found' });
    if (isPlatformManagedVapiAccount(existing)) {
      return res.status(403).json({
        error: 'This platform-funded Vapi account is managed by the service operator',
      });
    }
    const providerResult = providerSchema.safeParse(existing.provider);
    if (!providerResult.success) return res.status(409).json({ error: 'Unsupported provider account' });
    const provider = providerResult.data;

    let externalAccountId: string;
    let config: Record<string, unknown>;
    try {
      externalAccountId = parseExternalAccountId(
        provider,
        parsed.data.externalAccountId ?? existing.externalAccountId
      );
      config = parseAccountConfig(provider, parsed.data.config ?? existing.config);
    } catch (error) {
      return invalidRequest(res, error);
    }
    if (provider === 'vapi' && providerCredentialSource({ provider, config }) === 'platform') {
      return res.status(403).json({
        error: 'Platform-funded Vapi accounts can only be configured by the service operator',
      });
    }

    if (externalAccountId !== existing.externalAccountId) {
      return res.status(409).json({
        error: 'Provider account identifiers are immutable; create a separately verified account',
      });
    }

    const status = parsed.data.status ?? existing.status;
    let admissionUpdates: Array<{ id: string; config: Record<string, unknown> }> = [];
    if (status === 'active') {
      if (!(await requireActiveOrganizationForActivation(res, organizationId))) return;
      const readinessError = accountReadinessError({
        organizationId,
        provider,
        externalAccountId,
        credentialsEncrypted: existing.credentialsEncrypted,
        config,
      });
      if (readinessError) return res.status(422).json({ error: readinessError });
      try {
        admissionUpdates = await verifyActiveProviderResources({
          ...existing,
          config: config as Prisma.JsonValue,
        }, existing.resources);
      } catch (error) {
        if (error instanceof ProviderOwnershipVerificationError) {
          return ownershipErrorResponse(res, error);
        }
        return res.status(422).json({
          error: error instanceof Error
            ? error.message
            : 'An active provider resource could not be verified',
        });
      }
    }

    try {
      const [account] = await prisma.$transaction([
        prisma.providerAccount.update({
          where: { id: existing.id },
          data: {
            externalAccountId,
            status,
            config: config as Prisma.InputJsonValue,
          },
        }),
        ...admissionUpdates.map(update => prisma.providerResource.update({
          where: { id: update.id },
          data: { config: update.config as Prisma.InputJsonValue },
        })),
      ]);
      await auditAction(req, 'provider_account.updated', {
        organizationId,
        targetType: 'ProviderAccount',
        targetId: account.id,
        metadata: {
          provider,
          status,
          changedFields: Object.keys(parsed.data).sort(),
        },
      });
      return res.json({ account: safeAccount(account) });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return res.status(409).json({ error: 'Provider account assignment conflicts with an existing account' });
      }
      throw error;
    }
  }
);

router.post(
  '/dashboard/integrations/accounts/:id/credentials/rotate',
  ...manageIntegration,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const parsedId = providerEntityIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid provider account ID' });
    const parsed = credentialRotationSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);

    const existing = await prisma.providerAccount.findFirst({
      where: { id: parsedId.data, organizationId },
      include: { resources: { where: { status: 'active' } } },
    });
    if (!existing) return res.status(404).json({ error: 'Provider account not found' });
    if (isPlatformManagedVapiAccount(existing)) {
      return res.status(403).json({
        error: 'Platform Vapi credentials can only be rotated by the service operator',
      });
    }
    const providerResult = providerSchema.safeParse(existing.provider);
    if (!providerResult.success) return res.status(409).json({ error: 'Unsupported provider account' });
    const provider = providerResult.data;

    let encrypted: ReturnType<typeof encryptProviderCredentials>;
    let verifiedExternalAccountId = existing.externalAccountId;
    let admissionUpdates: Array<{ id: string; config: Record<string, unknown> }> = [];
    try {
      verifiedExternalAccountId = await verifyProviderAccountCredentials(
        provider,
        provider === 'twilio' ? existing.externalAccountId : undefined,
        parsed.data.credentials
      );
      if (provider === 'twilio' && verifiedExternalAccountId !== existing.externalAccountId) {
        throw new ProviderOwnershipVerificationError(
          'The new credentials belong to a different provider account',
          'not_owned'
        );
      }
      encrypted = encryptProviderCredentials(
        organizationId,
        provider,
        verifiedExternalAccountId,
        parsed.data.credentials
      );
      const candidateAccount = {
        ...existing,
        externalAccountId: verifiedExternalAccountId,
        credentialsEncrypted: encrypted.credentialsEncrypted,
      };
      if (!(await externalAccountIdAvailable(provider, verifiedExternalAccountId, existing.id))) {
        return res.status(409).json({ error: 'Those provider credentials are already assigned' });
      }
      admissionUpdates = await verifyActiveProviderResources(candidateAccount, existing.resources);
    } catch (error) {
      if (error instanceof ProviderOwnershipVerificationError) {
        return ownershipErrorResponse(res, error);
      }
      return invalidRequest(res, error);
    }

    let account: ProviderAccount;
    try {
      [account] = await prisma.$transaction([
        prisma.providerAccount.update({
          where: { id: existing.id },
          data: {
            ...encrypted,
            externalAccountId: verifiedExternalAccountId,
          },
        }),
        ...admissionUpdates.map(update => prisma.providerResource.update({
          where: { id: update.id },
          data: { config: update.config as Prisma.InputJsonValue },
        })),
      ]);
    } catch (error) {
      if (isUniqueConflict(error)) {
        return res.status(409).json({ error: 'Those provider credentials are already assigned' });
      }
      throw error;
    }
    await auditAction(req, 'provider_account.credentials_rotated', {
      organizationId,
      targetType: 'ProviderAccount',
      targetId: account.id,
      metadata: { provider },
    });
    return res.json({ account: safeAccount(account) });
  }
);

router.post(
  '/dashboard/integrations/resources',
  ...manageIntegration,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const parsed = providerResourceCreateSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const body = parsed.data;
    let effectiveResourceConfig: Record<string, unknown> | undefined = body.config;

    const account = await prisma.providerAccount.findFirst({
      where: { id: body.providerAccountId, organizationId },
    });
    if (!account) return res.status(404).json({ error: 'Provider account not found' });
    if (isPlatformManagedVapiAccount(account)) {
      return res.status(403).json({
        error: 'Platform-funded Vapi resources can only be bound by the service operator',
      });
    }
    if (account.organizationId !== organizationId || account.provider !== body.provider) {
      return res.status(409).json({ error: 'Provider account does not match this organization and resource' });
    }
    if (!(await verifyClinicOwnership(organizationId, body.clinicId))) {
      return res.status(403).json({ error: 'Clinic does not belong to the active organization' });
    }
    if (!(await externalResourceIdAvailable(body.provider, body.resourceType, body.externalId))) {
      return res.status(409).json({ error: 'That external provider resource is already assigned' });
    }

    // A provisioning row still reserves a globally unique external identifier,
    // so prove ownership before writing it. Otherwise a tenant could squat on a
    // different tenant's phone number or assistant while leaving it inactive.
    const readinessError = accountReadinessError(account);
    if (readinessError) return res.status(422).json({ error: readinessError });
    try {
      await verifyProviderResourceOwnership(account, {
        provider: body.provider,
        resourceType: body.resourceType,
        externalId: body.externalId,
      });
    } catch (error) {
      if (error instanceof ProviderOwnershipVerificationError) {
        return ownershipErrorResponse(res, error);
      }
      throw error;
    }

    if (body.status === 'active') {
      if (!(await requireActiveOrganizationForActivation(res, organizationId))) return;
      const activationIssue = productionVapiActivationIssue(account);
      if (activationIssue) return res.status(422).json({ error: activationIssue });
      if (account.status !== 'active') {
        return res.status(422).json({ error: 'The provider account must be active first' });
      }
      if (body.provider === 'vapi' && body.resourceType === 'phone_number') {
        const issue = await vapiInboundAssistantMappingIssue({
          providerAccountId: account.id,
          clinicId: body.clinicId,
          config: body.config,
        });
        if (issue) return res.status(422).json({ error: issue });
        if (vapiPhoneAcceptsInbound(body.config)) {
          const phoneConfig = parseResourceConfig('vapi', 'phone_number', body.config);
          try {
            await verifyVapiReceptionistConfiguration(account, {
              phoneNumberId: body.externalId,
              assistantId: String(phoneConfig.inboundAssistantId),
              expectedMaxDurationSeconds: getVapiInboundReservationSeconds(),
            });
          } catch (error) {
            if (error instanceof ProviderOwnershipVerificationError) {
              return ownershipErrorResponse(res, error);
            }
            return res.status(422).json({
              error: error instanceof Error ? error.message : 'Invalid Vapi inbound configuration',
            });
          }
          effectiveResourceConfig = {
            ...(body.config ?? {}),
            admissionVerifiedAt: new Date().toISOString(),
          };
        }
      }
    }

    try {
      const resource = await prisma.providerResource.create({
        data: {
          organizationId,
          clinicId: body.clinicId,
          providerAccountId: account.id,
          provider: body.provider,
          resourceType: body.resourceType,
          externalId: body.externalId,
          displayName: body.displayName,
          status: body.status,
          config: effectiveResourceConfig as Prisma.InputJsonValue | undefined,
        },
      });
      await auditAction(req, 'provider_resource.created', {
        organizationId,
        clinicId: resource.clinicId,
        targetType: 'ProviderResource',
        targetId: resource.id,
        metadata: {
          provider: resource.provider,
          resourceType: resource.resourceType,
          status: resource.status,
        },
      });
      return res.status(201).json({ resource: safeResource(resource) });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return res.status(409).json({ error: 'Provider resource assignment conflicts with an existing resource' });
      }
      throw error;
    }
  }
);

router.patch(
  '/dashboard/integrations/resources/:id',
  ...manageIntegration,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const parsedId = providerEntityIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid provider resource ID' });
    const parsed = providerResourceUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);

    const existing = await prisma.providerResource.findFirst({
      where: { id: parsedId.data, organizationId },
      include: { providerAccount: true },
    });
    if (!existing) return res.status(404).json({ error: 'Provider resource not found' });
    if (isPlatformManagedVapiAccount(existing.providerAccount)) {
      return res.status(403).json({
        error: 'Platform-funded Vapi resources are managed by the service operator',
      });
    }
    const providerResult = providerSchema.safeParse(existing.provider);
    if (!providerResult.success) return res.status(409).json({ error: 'Unsupported provider resource' });
    const provider = providerResult.data;

    const effectiveAccountId = parsed.data.providerAccountId ?? existing.providerAccountId;
    const account = await prisma.providerAccount.findFirst({
      where: { id: effectiveAccountId, organizationId },
    });
    if (!account) return res.status(404).json({ error: 'Provider account not found' });
    if (isPlatformManagedVapiAccount(account)) {
      return res.status(403).json({
        error: 'Platform-funded Vapi resources are managed by the service operator',
      });
    }
    if (account.organizationId !== organizationId || account.provider !== provider) {
      return res.status(409).json({ error: 'Provider account does not match this organization and resource' });
    }

    const hasClinicId = Object.prototype.hasOwnProperty.call(parsed.data, 'clinicId');
    const clinicId = hasClinicId ? parsed.data.clinicId ?? null : existing.clinicId;
    if (!(await verifyClinicOwnership(organizationId, clinicId))) {
      return res.status(403).json({ error: 'Clinic does not belong to the active organization' });
    }
    if (provider === 'vapi' && existing.resourceType === 'phone_number' && !clinicId) {
      return res.status(400).json({ error: 'A Vapi phone number must be assigned to a clinic' });
    }

    let externalId: string;
    let config: Record<string, unknown>;
    try {
      externalId = parseResourceExternalId(
        provider,
        existing.resourceType,
        parsed.data.externalId ?? existing.externalId
      );
      config = parseResourceConfig(
        provider,
        existing.resourceType,
        parsed.data.config ?? existing.config
      );
    } catch (error) {
      return invalidRequest(res, error);
    }

    const reassigned =
      effectiveAccountId !== existing.providerAccountId ||
      externalId !== existing.externalId ||
      clinicId !== existing.clinicId;
    if (existing.status === 'active' && reassigned) {
      return res.status(409).json({
        error: 'Deactivate the provider resource before changing its account, external identifier, or clinic',
      });
    }
    if (!(await externalResourceIdAvailable(provider, existing.resourceType, externalId, existing.id))) {
      return res.status(409).json({ error: 'That external provider resource is already assigned' });
    }

    const status = parsed.data.status ?? existing.status;
    const activating = existing.status !== 'active' && status === 'active';
    if (
      provider === 'vapi' &&
      existing.resourceType === 'assistant' &&
      existing.status === 'active' &&
      status !== 'active'
    ) {
      const dependentPhones = await activeInboundPhonesUsingAssistant({
        providerAccountId: existing.providerAccountId,
        assistantId: existing.externalId,
      });
      if (dependentPhones.length > 0) {
        return res.status(409).json({
          error: 'Deactivate dependent inbound Vapi phone numbers before deactivating this assistant',
        });
      }
    }
    if (status === 'active') {
      const readinessError = accountReadinessError(account);
      if (readinessError) return res.status(422).json({ error: readinessError });
    }
    if (reassigned || activating) {
      try {
        await verifyProviderResourceOwnership(account, {
          provider,
          resourceType: existing.resourceType,
          externalId,
        });
      } catch (error) {
        if (error instanceof ProviderOwnershipVerificationError) {
          return ownershipErrorResponse(res, error);
        }
        throw error;
      }
    }

    if (status === 'active') {
      if (!(await requireActiveOrganizationForActivation(res, organizationId))) return;
      const activationIssue = productionVapiActivationIssue(account);
      if (activationIssue) return res.status(422).json({ error: activationIssue });
      if (account.status !== 'active') {
        return res.status(422).json({ error: 'The provider account must be active first' });
      }
      if (provider === 'vapi' && existing.resourceType === 'phone_number') {
        const issue = await vapiInboundAssistantMappingIssue({
          providerAccountId: account.id,
          clinicId,
          config,
        });
        if (issue) return res.status(422).json({ error: issue });
        if (vapiPhoneAcceptsInbound(config)) {
          const phoneConfig = parseResourceConfig('vapi', 'phone_number', config);
          try {
            await verifyVapiReceptionistConfiguration(account, {
              phoneNumberId: externalId,
              assistantId: String(phoneConfig.inboundAssistantId),
              expectedMaxDurationSeconds: getVapiInboundReservationSeconds(),
            });
          } catch (error) {
            if (error instanceof ProviderOwnershipVerificationError) {
              return ownershipErrorResponse(res, error);
            }
            return res.status(422).json({
              error: error instanceof Error ? error.message : 'Invalid Vapi inbound configuration',
            });
          }
          config = { ...config, admissionVerifiedAt: new Date().toISOString() };
        }
      }
    }

    try {
      const resource = await prisma.providerResource.update({
        where: { id: existing.id },
        data: {
          providerAccountId: effectiveAccountId,
          clinicId,
          externalId,
          displayName: parsed.data.displayName,
          status,
          config: config as Prisma.InputJsonValue,
        },
      });
      await auditAction(req, 'provider_resource.updated', {
        organizationId,
        clinicId: resource.clinicId,
        targetType: 'ProviderResource',
        targetId: resource.id,
        metadata: {
          provider,
          resourceType: resource.resourceType,
          status,
          changedFields: Object.keys(parsed.data).sort(),
        },
      });
      return res.json({ resource: safeResource(resource) });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return res.status(409).json({ error: 'Provider resource assignment conflicts with an existing resource' });
      }
      throw error;
    }
  }
);

router.post(
  '/dashboard/integrations/resources/:id/deactivate',
  ...manageIntegration,
  async (req: Request, res: Response) => {
    const organizationId = req.auth!.organizationId;
    const parsedId = providerEntityIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return res.status(400).json({ error: 'Invalid provider resource ID' });

    const existing = await prisma.providerResource.findFirst({
      where: { id: parsedId.data, organizationId },
      include: { providerAccount: true },
    });
    if (!existing) return res.status(404).json({ error: 'Provider resource not found' });
    if (isPlatformManagedVapiAccount(existing.providerAccount)) {
      return res.status(403).json({
        error: 'Platform-funded Vapi resources are managed by the service operator',
      });
    }
    if (existing.organizationId !== organizationId) {
      return res.status(403).json({ error: 'Provider resource does not belong to the active organization' });
    }
    if (existing.provider === 'vapi' && existing.resourceType === 'assistant') {
      const dependentPhones = await activeInboundPhonesUsingAssistant({
        providerAccountId: existing.providerAccountId,
        assistantId: existing.externalId,
      });
      if (dependentPhones.length > 0) {
        return res.status(409).json({
          error: 'Deactivate dependent inbound Vapi phone numbers before deactivating this assistant',
        });
      }
    }

    const resource = await prisma.providerResource.update({
      where: { id: existing.id },
      data: { status: 'inactive' },
    });
    await auditAction(req, 'provider_resource.deactivated', {
      organizationId,
      clinicId: resource.clinicId,
      targetType: 'ProviderResource',
      targetId: resource.id,
      metadata: {
        provider: resource.provider,
        resourceType: resource.resourceType,
      },
    });
    return res.json({ resource: safeResource(resource) });
  }
);

export default router;
