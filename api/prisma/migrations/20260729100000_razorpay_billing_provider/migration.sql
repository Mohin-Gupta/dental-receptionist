-- This is a forward-only provider cutover. Refuse to remove the Stripe runtime
-- until every state that still needs it has been settled. These checks run
-- before any DDL so a failed preflight leaves the old release schema intact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SubscriptionMirror"
    WHERE "billingProvider" = 'stripe'
      AND (
        "activeKey" IS NOT NULL
        OR "status" NOT IN ('canceled', 'incomplete_expired')
      )
  ) THEN
    RAISE EXCEPTION
      'Stripe-to-Razorpay cutover blocked: a live or controlling Stripe subscription remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "BillingCheckoutSession"
    WHERE "billingProvider" = 'stripe'
      AND (
        "activeKey" IS NOT NULL
        OR "status" NOT IN ('completed', 'expired', 'failed', 'superseded')
      )
  ) THEN
    RAISE EXCEPTION
      'Stripe-to-Razorpay cutover blocked: an active or unresolved Stripe checkout remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "UsageExport"
    WHERE "billingProvider" = 'stripe'
      AND "status" <> 'exported'
  ) THEN
    RAISE EXCEPTION
      'Stripe-to-Razorpay cutover blocked: an unresolved Stripe usage export remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ProviderWebhookEvent"
    WHERE "provider" = 'stripe'
      AND "status" <> 'processed'
  ) THEN
    RAISE EXCEPTION
      'Stripe-to-Razorpay cutover blocked: an unresolved Stripe webhook remains';
  END IF;
END
$$;

-- Expand the billing schema after the preflight. Existing terminal Stripe rows
-- remain immutable history; exactly one provider account may control an
-- organization's current access at a time. The default protects inserts from a
-- pre-cutover binary that does not know about activeKey.
ALTER TABLE "BillingAccount"
  ADD COLUMN "activeKey" TEXT DEFAULT 'current',
  ALTER COLUMN "externalCustomerId" DROP NOT NULL;

-- The checks above prove that these are historical Stripe accounts. Release
-- their controller claim so the new application can create a Razorpay account
-- without deleting provider or audit history.
UPDATE "BillingAccount"
SET "activeKey" = NULL
WHERE "billingProvider" = 'stripe';

DROP INDEX "BillingAccount_organizationId_key";

CREATE UNIQUE INDEX "BillingAccount_organizationId_billingProvider_key"
  ON "BillingAccount"("organizationId", "billingProvider");
CREATE UNIQUE INDEX "BillingAccount_organizationId_activeKey_key"
  ON "BillingAccount"("organizationId", "activeKey");
CREATE UNIQUE INDEX "BillingAccount_id_organizationId_billingProvider_key"
  ON "BillingAccount"("id", "organizationId", "billingProvider");

ALTER TABLE "BillingAccount"
  ADD CONSTRAINT "BillingAccount_activeKey_check"
  CHECK ("activeKey" IS NULL OR "activeKey" = 'current');

ALTER TABLE "BillingCheckoutSession"
  ADD COLUMN "externalPaymentId" TEXT,
  ADD COLUMN "checkoutVerifiedAt" TIMESTAMP(3);

ALTER TABLE "SubscriptionMirror"
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "lastProviderEventId" TEXT;

ALTER TABLE "ProviderWebhookEvent"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

DROP INDEX "ProviderWebhookEvent_status_processingStartedAt_receivedAt_idx";
CREATE INDEX "ProviderWebhookEvent_status_retry_processing_received_idx"
  ON "ProviderWebhookEvent"("status", "nextAttemptAt", "processingStartedAt", "receivedAt");

UPDATE "SubscriptionMirror"
SET "providerStatus" = "status"
WHERE "providerStatus" IS NULL;

ALTER TABLE "BillingCheckoutSession"
  DROP CONSTRAINT "BillingCheckoutSession_billingAccountId_organizationId_fkey";
ALTER TABLE "BillingCheckoutSession"
  ADD CONSTRAINT "BillingCheckoutSession_billingAccountId_org_provider_fkey"
  FOREIGN KEY ("billingAccountId", "organizationId", "billingProvider")
  REFERENCES "BillingAccount"("id", "organizationId", "billingProvider")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubscriptionMirror"
  DROP CONSTRAINT "SubscriptionMirror_billingAccountId_organizationId_fkey";
ALTER TABLE "SubscriptionMirror"
  ADD CONSTRAINT "SubscriptionMirror_billingAccountId_org_provider_fkey"
  FOREIGN KEY ("billingAccountId", "organizationId", "billingProvider")
  REFERENCES "BillingAccount"("id", "organizationId", "billingProvider")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BillingCheckoutSession"
  ADD CONSTRAINT "BillingCheckoutSession_activeKey_check"
  CHECK ("activeKey" IS NULL OR "activeKey" = 'active');

ALTER TABLE "SubscriptionMirror"
  ADD CONSTRAINT "SubscriptionMirror_activeKey_check"
  CHECK ("activeKey" IS NULL OR "activeKey" = 'current');

-- The fixed-price Razorpay integration does not export the local usage ledger.
-- Remove the obsolete recurring-task row so worker health does not remain
-- unhealthy after the old Stripe exporter is retired.
DELETE FROM "WorkerTaskStatus"
WHERE "name" = 'Stripe usage export';

-- Cancellation POSTs have no provider idempotency key. Keep their durable
-- replay and retry state in an indexed relation instead of scanning JSON
-- projection payloads, and lease background reconciliation across workers.
CREATE TABLE "BillingCancellationAttempt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "subscriptionMirrorId" TEXT NOT NULL,
  "billingProvider" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'submitting',
  "activeKey" TEXT DEFAULT 'active',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "processingStartedAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCancellationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingCancellationAttempt_org_provider_request_key"
  ON "BillingCancellationAttempt"("organizationId", "billingProvider", "requestHash");
CREATE UNIQUE INDEX "BillingCancellationAttempt_subscription_active_key"
  ON "BillingCancellationAttempt"("subscriptionMirrorId", "activeKey");
CREATE INDEX "BillingCancellationAttempt_provider_status_retry_processing_idx"
  ON "BillingCancellationAttempt"(
    "billingProvider",
    "status",
    "nextAttemptAt",
    "processingStartedAt",
    "createdAt"
  );
CREATE INDEX "BillingCancellationAttempt_subscriptionMirrorId_status_createdAt_idx"
  ON "BillingCancellationAttempt"("subscriptionMirrorId", "status", "createdAt");

ALTER TABLE "BillingCancellationAttempt"
  ADD CONSTRAINT "BillingCancellationAttempt_subscriptionMirrorId_organizationId_fkey"
  FOREIGN KEY ("subscriptionMirrorId", "organizationId")
  REFERENCES "SubscriptionMirror"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingCancellationAttempt_mode_check"
  CHECK ("mode" IN ('immediate', 'period_end')),
  ADD CONSTRAINT "BillingCancellationAttempt_status_check"
  CHECK ("status" IN ('submitting', 'processing', 'confirmed', 'failed')),
  ADD CONSTRAINT "BillingCancellationAttempt_active_state_check"
  CHECK (
    (
      "status" IN ('submitting', 'processing')
      AND "activeKey" = 'active'
    )
    OR (
      "status" IN ('confirmed', 'failed')
      AND "activeKey" IS NULL
    )
  ),
  ADD CONSTRAINT "BillingCancellationAttempt_lease_check"
  CHECK (
    (
      "status" = 'processing'
      AND "leaseToken" IS NOT NULL
      AND "processingStartedAt" IS NOT NULL
    )
    OR (
      "status" <> 'processing'
      AND "leaseToken" IS NULL
      AND "processingStartedAt" IS NULL
    )
  ),
  ADD CONSTRAINT "BillingCancellationAttempt_attempts_check"
  CHECK ("attempts" >= 0);
