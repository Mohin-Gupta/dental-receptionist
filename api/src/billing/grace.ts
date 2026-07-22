import { prisma } from '../lib/prisma';

export async function expireOrganizationBillingGrace(organizationId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-subscription:${organizationId}`}, 0))`;
    const controller = await tx.subscriptionMirror.findFirst({
      where: {
        organizationId,
        billingProvider: 'stripe',
        activeKey: 'current',
      },
      select: { id: true, status: true, graceUntil: true },
    });
    if (
      !controller ||
      controller.status !== 'past_due' ||
      !controller.graceUntil ||
      controller.graceUntil > now
    ) {
      return false;
    }

    await tx.organization.updateMany({
      where: { id: organizationId, status: 'past_due_grace' },
      data: { status: 'suspended' },
    });
    await tx.entitlement.updateMany({
      where: {
        organizationId,
        source: 'stripe-plan',
        subscriptionMirrorId: controller.id,
      },
      data: { enabled: false, expiresAt: controller.graceUntil },
    });
    return true;
  });
}

/** Worker entry point; deliberately not scheduled from the API process. */
export async function expireElapsedBillingGrace(limit = 100, now = new Date()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Grace expiry batch limit must be between 1 and 500');
  }
  const organizations = await prisma.subscriptionMirror.findMany({
    where: {
      billingProvider: 'stripe',
      activeKey: 'current',
      status: 'past_due',
      graceUntil: { lte: now },
    },
    distinct: ['organizationId'],
    select: { organizationId: true },
    take: limit,
  });
  let expired = 0;
  for (const item of organizations) {
    if (await expireOrganizationBillingGrace(item.organizationId, now)) expired += 1;
  }
  return expired;
}
