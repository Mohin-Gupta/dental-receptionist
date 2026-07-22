import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { getCommunicationPreferenceHmacKeyring } from '../config/communicationPreferences';

export type CommunicationConsentPolicy = 'block_opt_out' | 'require_opt_in';
export type CommunicationPreferenceStatus = 'opted_in' | 'opted_out';

export class CommunicationPreferenceError extends Error {
  constructor(readonly code: 'opted_out' | 'opt_in_required') {
    super(code === 'opted_out'
      ? 'The recipient has opted out of SMS communications'
      : 'Explicit SMS opt-in is required for this message');
    this.name = 'CommunicationPreferenceError';
  }
}

function communicationAddressHash(
  organizationId: string,
  channel: string,
  normalizedAddress: string,
  key: { id: string; value: Buffer }
): string {
  const digest = crypto
    .createHmac('sha256', key.value)
    .update(`${organizationId}\0${channel}\0${normalizedAddress}`)
    .digest('hex');
  return `${key.id}.${digest}`;
}

function addressHashes(organizationId: string, channel: string, normalizedAddress: string) {
  const keyring = getCommunicationPreferenceHmacKeyring();
  return {
    active: communicationAddressHash(organizationId, channel, normalizedAddress, keyring.active),
    all: keyring.keys.map(key =>
      communicationAddressHash(organizationId, channel, normalizedAddress, key)
    ),
  };
}

export async function assertCommunicationAllowed(input: {
  organizationId: string;
  channel: 'sms';
  normalizedAddress: string;
  policy?: CommunicationConsentPolicy;
}) {
  const hashes = addressHashes(
    input.organizationId,
    input.channel,
    input.normalizedAddress
  );
  const preference = await prisma.communicationPreference.findFirst({
    where: { organizationId: input.organizationId, channel: input.channel, addressHash: { in: hashes.all } },
    orderBy: { effectiveAt: 'desc' },
    select: { status: true },
  });

  if (preference?.status === 'opted_out') {
    throw new CommunicationPreferenceError('opted_out');
  }
  if (input.policy === 'require_opt_in' && preference?.status !== 'opted_in') {
    throw new CommunicationPreferenceError('opt_in_required');
  }
}

export async function recordCommunicationPreference(input: {
  organizationId: string;
  clinicId?: string | null;
  channel: 'sms';
  normalizedAddress: string;
  status: CommunicationPreferenceStatus;
  source: string;
  providerEventId?: string | null;
  effectiveAt?: Date;
}) {
  const hashes = addressHashes(
    input.organizationId,
    input.channel,
    input.normalizedAddress
  );
  const effectiveAt = input.effectiveAt ?? new Date();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`communication-preference:${input.organizationId}:${input.channel}:${hashes.active}`}, 0))`;
    const existing = await tx.communicationPreference.findMany({
      where: {
        organizationId: input.organizationId,
        channel: input.channel,
        addressHash: { in: hashes.all },
      },
      orderBy: { effectiveAt: 'desc' },
    });
    const target = existing.find(row => row.addressHash === hashes.active) ?? existing[0];
    if (target) {
      await tx.communicationPreference.deleteMany({
        where: { id: { in: existing.filter(row => row.id !== target.id).map(row => row.id) } },
      });
      return tx.communicationPreference.update({
        where: { id: target.id },
        data: {
          addressHash: hashes.active,
          clinicId: input.clinicId ?? undefined,
          status: input.status,
          source: input.source,
          lastProviderEventId: input.providerEventId ?? undefined,
          effectiveAt,
        },
      });
    }
    return tx.communicationPreference.create({
      data: {
        organizationId: input.organizationId,
        clinicId: input.clinicId ?? null,
        channel: input.channel,
        addressHash: hashes.active,
        status: input.status,
        source: input.source,
        lastProviderEventId: input.providerEventId ?? null,
        effectiveAt,
      },
    });
  });
}
