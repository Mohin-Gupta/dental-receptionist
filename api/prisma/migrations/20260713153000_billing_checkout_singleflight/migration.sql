-- Refuse to guess which provider subscription should control access. Resolve
-- any pre-existing duplicate current subscriptions before applying this change.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SubscriptionMirror"
    WHERE "status" IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused')
    GROUP BY "organizationId", "billingProvider"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate current subscriptions must be resolved before migration';
  END IF;
END
$$;

ALTER TABLE "SubscriptionMirror" ADD COLUMN "activeKey" TEXT;

UPDATE "SubscriptionMirror"
SET "activeKey" = 'current'
WHERE "status" IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused');

CREATE UNIQUE INDEX "SubscriptionMirror_organizationId_billingProvider_activeKey_key"
  ON "SubscriptionMirror"("organizationId", "billingProvider", "activeKey");

CREATE TABLE "BillingCheckoutSession" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "billingAccountId" TEXT NOT NULL,
  "billingProvider" TEXT NOT NULL,
  "requestKeyHash" TEXT NOT NULL,
  "planKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'creating',
  "activeKey" TEXT,
  "externalSessionId" TEXT,
  "sessionUrlCiphertext" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCheckoutSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingCheckoutSession_billingProvider_externalSessionId_key"
  ON "BillingCheckoutSession"("billingProvider", "externalSessionId");
CREATE UNIQUE INDEX "BillingCheckoutSession_org_provider_request_key"
  ON "BillingCheckoutSession"("organizationId", "billingProvider", "requestKeyHash");
CREATE UNIQUE INDEX "BillingCheckoutSession_org_provider_active_key"
  ON "BillingCheckoutSession"("organizationId", "billingProvider", "activeKey");
CREATE INDEX "BillingCheckoutSession_organizationId_status_expiresAt_idx"
  ON "BillingCheckoutSession"("organizationId", "status", "expiresAt");

ALTER TABLE "BillingCheckoutSession"
  ADD CONSTRAINT "BillingCheckoutSession_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingCheckoutSession_billingAccountId_organizationId_fkey"
    FOREIGN KEY ("billingAccountId", "organizationId") REFERENCES "BillingAccount"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;
