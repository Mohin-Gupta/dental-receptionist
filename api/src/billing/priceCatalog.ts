import { Prisma, type PriceVersion } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getStripePlans, type StripePlanMap } from './config';
import { USAGE_METRIC_VALUES } from './metrics';

const planKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/);
const metricSchema = z.enum(USAGE_METRIC_VALUES);
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const positiveMinorAmountSchema = z.string()
  .regex(/^[1-9]\d{0,17}$/)
  .transform(value => BigInt(value));
const positiveUnitQuantitySchema = z.string()
  .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/)
  .refine(value => new Prisma.Decimal(value).greaterThan(0), 'Unit quantity must be positive')
  .transform(value => new Prisma.Decimal(value));
const effectiveDateSchema = z.string()
  .datetime({ offset: true })
  .transform(value => new Date(value));

const configuredPriceVersionSchema = z.object({
  planKey: planKeySchema,
  metric: metricSchema,
  version: versionSchema,
  currency: currencySchema,
  unitAmountMinor: positiveMinorAmountSchema,
  unitQuantity: positiveUnitQuantitySchema,
  effectiveFrom: effectiveDateSchema,
  effectiveTo: effectiveDateSchema.nullable().default(null),
}).strict();

const configuredPriceVersionsSchema = z.array(configuredPriceVersionSchema).max(5_000).superRefine(
  (entries, context) => {
    const composites = new Set<string>();
    const effectiveStarts = new Set<string>();

    entries.forEach((entry, index) => {
      if (entry.effectiveTo && entry.effectiveTo <= entry.effectiveFrom) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'effectiveTo'],
          message: 'effectiveTo must be later than effectiveFrom',
        });
      }

      const composite = priceCompositeKey(entry);
      if (composites.has(composite)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Duplicate plan/metric/version/currency price version',
        });
      }
      composites.add(composite);

      const effectiveStart = `${priceGroupKey(entry)}:${entry.effectiveFrom.toISOString()}`;
      if (effectiveStarts.has(effectiveStart)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'effectiveFrom'],
          message: 'Two price versions cannot share an effective start in one price group',
        });
      }
      effectiveStarts.add(effectiveStart);
    });
  }
);

export type ConfiguredPriceVersion = z.infer<typeof configuredPriceVersionSchema>;

export class PriceCatalogConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceCatalogConfigurationError';
  }
}

export class PriceCatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceCatalogConflictError';
  }
}

function priceCompositeKey(entry: {
  planKey: string;
  metric: string;
  version: string;
  currency: string;
}) {
  return [entry.planKey, entry.metric, entry.version, entry.currency].join(':');
}

function priceGroupKey(entry: { planKey: string; metric: string; currency: string }) {
  return [entry.planKey, entry.metric, entry.currency].join(':');
}

function issuePath(path: Array<PropertyKey>): string {
  return path.length > 0 ? path.map(String).join('.') : 'catalog';
}

export function parseConfiguredPriceVersions(raw: string): ConfiguredPriceVersion[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new PriceCatalogConfigurationError(
      'BILLING_PRICE_VERSIONS_JSON must contain valid JSON'
    );
  }

  const parsed = configuredPriceVersionsSchema.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PriceCatalogConfigurationError(
      `Invalid BILLING_PRICE_VERSIONS_JSON at ${issuePath(issue?.path ?? [])}: ` +
      `${issue?.message ?? 'invalid price catalog'}`
    );
  }
  return parsed.data;
}

export function getConfiguredPriceVersions(): ConfiguredPriceVersion[] {
  const raw = process.env.BILLING_PRICE_VERSIONS_JSON;
  if (!raw?.trim()) {
    throw new PriceCatalogConfigurationError('BILLING_PRICE_VERSIONS_JSON is required');
  }
  return parseConfiguredPriceVersions(raw);
}

function appliesAt(entry: ConfiguredPriceVersion, now: Date): boolean {
  return entry.effectiveFrom <= now && (!entry.effectiveTo || entry.effectiveTo > now);
}

function validateEffectiveWindows(entries: ConfiguredPriceVersion[]) {
  const groups = new Map<string, ConfiguredPriceVersion[]>();
  for (const entry of entries) {
    const key = priceGroupKey(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  for (const [key, group] of groups) {
    group.sort((left, right) => left.effectiveFrom.getTime() - right.effectiveFrom.getTime());
    for (let index = 0; index < group.length - 1; index += 1) {
      const current = group[index];
      const next = group[index + 1];
      // An open-ended version is implicitly superseded by the next version.
      // An explicit end must meet the successor exactly so the catalog cannot
      // introduce a gap or an ambiguous explicit overlap.
      if (
        current.effectiveTo &&
        current.effectiveTo.getTime() !== next.effectiveFrom.getTime()
      ) {
        throw new PriceCatalogConfigurationError(
          `Price window ${key}:${current.version} must end when its successor starts`
        );
      }
    }
    if (group[group.length - 1]?.effectiveTo) {
      throw new PriceCatalogConfigurationError(
        `Latest configured price window for ${key} must be open-ended`
      );
    }
  }
}

function validateStripeCompatibility(
  entries: ConfiguredPriceVersion[],
  plans: StripePlanMap,
  now: Date
) {
  for (const entry of entries) {
    const plan = plans[entry.planKey];
    if (!plan) {
      throw new PriceCatalogConfigurationError(
        `Price version references unknown Stripe plan ${entry.planKey}`
      );
    }
    if (!plan.meteredPriceIds[entry.metric] || !plan.meterEventNames[entry.metric]) {
      throw new PriceCatalogConfigurationError(
        `Price version ${priceCompositeKey(entry)} is not a configured Stripe metered metric`
      );
    }
  }

  for (const [planKey, plan] of Object.entries(plans)) {
    for (const metric of Object.keys(plan.meteredPriceIds)) {
      if (!entries.some(entry => (
        entry.planKey === planKey && entry.metric === metric && appliesAt(entry, now)
      ))) {
        throw new PriceCatalogConfigurationError(
          `No currently effective local price is configured for ${planKey}:${metric}`
        );
      }
    }
  }
}

function immutableFieldsMatch(existing: PriceVersion, configured: ConfiguredPriceVersion): boolean {
  return (
    existing.planKey === configured.planKey &&
    existing.metric === configured.metric &&
    existing.version === configured.version &&
    existing.currency === configured.currency &&
    existing.unitAmountMinor === configured.unitAmountMinor &&
    existing.unitQuantity.equals(configured.unitQuantity) &&
    existing.effectiveFrom.getTime() === configured.effectiveFrom.getTime() &&
    (existing.effectiveTo?.getTime() ?? null) === (configured.effectiveTo?.getTime() ?? null) &&
    existing.status === 'active'
  );
}

function validateExistingCatalog(
  existing: PriceVersion[],
  configured: ConfiguredPriceVersion[]
) {
  const existingByComposite = new Map(
    existing.map(entry => [priceCompositeKey(entry), entry])
  );
  const existingByStart = new Map(
    existing.map(entry => [
      `${priceGroupKey(entry)}:${entry.effectiveFrom.toISOString()}`,
      entry,
    ])
  );
  const configuredKeys = new Set(configured.map(priceCompositeKey));
  const earliestConfiguredStart = new Map<string, number>();

  for (const entry of configured) {
    const composite = priceCompositeKey(entry);
    const match = existingByComposite.get(composite);
    if (match && !immutableFieldsMatch(match, entry)) {
      throw new PriceCatalogConflictError(
        `Immutable price version ${composite} differs from BILLING_PRICE_VERSIONS_JSON`
      );
    }

    const startKey = `${priceGroupKey(entry)}:${entry.effectiveFrom.toISOString()}`;
    const sameStart = existingByStart.get(startKey);
    if (sameStart && priceCompositeKey(sameStart) !== composite) {
      throw new PriceCatalogConflictError(
        `Database price ${priceCompositeKey(sameStart)} already owns effective start ${startKey}`
      );
    }

    const group = priceGroupKey(entry);
    earliestConfiguredStart.set(
      group,
      Math.min(earliestConfiguredStart.get(group) ?? Number.POSITIVE_INFINITY, entry.effectiveFrom.getTime())
    );
  }

  // Once a group is managed from a configured point in time onward, reject
  // unlisted versions in that range. Historical rows before adoption remain
  // valid and immutable, while current/future drift fails the deployment.
  for (const entry of existing) {
    const managedFrom = earliestConfiguredStart.get(priceGroupKey(entry));
    if (
      managedFrom !== undefined &&
      entry.effectiveFrom.getTime() >= managedFrom &&
      !configuredKeys.has(priceCompositeKey(entry))
    ) {
      throw new PriceCatalogConflictError(
        `Database price ${priceCompositeKey(entry)} is not present in the configured catalog`
      );
    }
  }
}

async function validateOperationalTenantCoverage(
  tx: Prisma.TransactionClient,
  entries: ConfiguredPriceVersion[],
  plans: StripePlanMap,
  now: Date
) {
  const organizations = await tx.organization.findMany({
    where: { status: { in: ['active', 'past_due_grace'] } },
    select: {
      id: true,
      planTier: true,
      billingAccount: { select: { currency: true } },
    },
  });

  for (const organization of organizations) {
    if (!organization.billingAccount) continue;
    const plan = plans[organization.planTier];
    if (!plan) {
      throw new PriceCatalogConfigurationError(
        `Operational organization ${organization.id} uses unavailable plan ${organization.planTier}`
      );
    }
    for (const metric of Object.keys(plan.meteredPriceIds)) {
      const covered = entries.some(entry => (
        entry.planKey === organization.planTier &&
        entry.metric === metric &&
        entry.currency === organization.billingAccount!.currency &&
        appliesAt(entry, now)
      ));
      if (!covered) {
        throw new PriceCatalogConfigurationError(
          `No current ${organization.billingAccount.currency} price covers ` +
          `${organization.planTier}:${metric} for operational organization ${organization.id}`
        );
      }
    }
  }
}

export interface PriceCatalogSyncResult {
  configured: number;
  created: number;
  unchanged: number;
}

/**
 * Materializes the operator-controlled local retail-rate catalog.
 *
 * The operation is append-only: it creates missing immutable versions and
 * rejects any attempt to alter or replace an existing composite version.
 */
export async function syncConfiguredPriceVersions(
  now = new Date()
): Promise<PriceCatalogSyncResult> {
  const plans = getStripePlans();
  const configured = getConfiguredPriceVersions();
  validateEffectiveWindows(configured);
  validateStripeCompatibility(configured, plans, now);

  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('billing-price-catalog', 0))`;
    await validateOperationalTenantCoverage(tx, configured, plans, now);

    const existing = configured.length === 0
      ? []
      : await tx.priceVersion.findMany({
          where: {
            planKey: { in: [...new Set(configured.map(entry => entry.planKey))] },
            metric: { in: [...new Set(configured.map(entry => entry.metric))] },
            currency: { in: [...new Set(configured.map(entry => entry.currency))] },
          },
        });
    validateExistingCatalog(existing, configured);
    const existingKeys = new Set(existing.map(priceCompositeKey));

    let created = 0;
    let unchanged = 0;
    const ordered = [...configured].sort((left, right) => (
      priceCompositeKey(left).localeCompare(priceCompositeKey(right)) ||
      left.effectiveFrom.getTime() - right.effectiveFrom.getTime()
    ));
    for (const entry of ordered) {
      if (existingKeys.has(priceCompositeKey(entry))) {
        unchanged += 1;
        continue;
      }
      await tx.priceVersion.create({
        data: {
          planKey: entry.planKey,
          metric: entry.metric,
          version: entry.version,
          currency: entry.currency,
          unitAmountMinor: entry.unitAmountMinor,
          unitQuantity: entry.unitQuantity,
          effectiveFrom: entry.effectiveFrom,
          effectiveTo: entry.effectiveTo,
          status: 'active',
          metadata: { managedBy: 'BILLING_PRICE_VERSIONS_JSON' },
        },
      });
      created += 1;
    }

    return { configured: configured.length, created, unchanged };
  }, {
    // READ COMMITTED takes the catalog snapshot after a concurrent synchronizer
    // releases the advisory lock. A transaction-wide snapshot established
    // while waiting could miss the winner's inserts and defeat idempotency.
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 10_000,
    timeout: 60_000,
  });
}
