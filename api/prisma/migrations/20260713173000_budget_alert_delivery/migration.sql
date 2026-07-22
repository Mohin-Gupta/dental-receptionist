CREATE UNIQUE INDEX "TenantBudget_id_organizationId_key"
  ON "TenantBudget"("id", "organizationId");

CREATE UNIQUE INDEX "TenantBudget_one_active_scope_key"
  ON "TenantBudget"("organizationId", "clinicId", "metric", "period")
  NULLS NOT DISTINCT
  WHERE "status" = 'active';

ALTER TABLE "TenantBudget"
  ADD CONSTRAINT "TenantBudget_currency_check"
    CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$') NOT VALID,
  ADD CONSTRAINT "TenantBudget_positive_limits_check"
    CHECK (
      ("softLimitQuantity" IS NULL OR "softLimitQuantity" > 0) AND
      ("hardLimitQuantity" IS NULL OR "hardLimitQuantity" > 0) AND
      ("softLimitAmountMinor" IS NULL OR "softLimitAmountMinor" > 0) AND
      ("hardLimitAmountMinor" IS NULL OR "hardLimitAmountMinor" > 0)
    ) NOT VALID,
  ADD CONSTRAINT "TenantBudget_reservable_enforcement_check"
    CHECK (
      "metric" IN ('voice_seconds', 'sms_segments') OR (
        "enforcementMode" = 'alert' AND
        "hardLimitQuantity" IS NULL AND
        "hardLimitAmountMinor" IS NULL
      )
    ) NOT VALID;

CREATE TABLE "BudgetAlertDelivery" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "tenantBudgetId" TEXT NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "threshold" INTEGER NOT NULL,
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3) NOT NULL,
  "actualQuantity" DECIMAL(20,6),
  "actualAmountMinor" BIGINT,
  "limitQuantity" DECIMAL(20,6),
  "limitAmountMinor" BIGINT,
  "currency" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lockedAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastError" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BudgetAlertDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BudgetAlert_budget_period_threshold_dimension_recipient_key"
  ON "BudgetAlertDelivery"("tenantBudgetId", "periodStart", "threshold", "dimension", "recipientUserId");
CREATE INDEX "BudgetAlert_status_retry_created_idx"
  ON "BudgetAlertDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "BudgetAlertDelivery_organizationId_createdAt_idx"
  ON "BudgetAlertDelivery"("organizationId", "createdAt");
CREATE INDEX "BudgetAlertDelivery_recipientUserId_createdAt_idx"
  ON "BudgetAlertDelivery"("recipientUserId", "createdAt");

ALTER TABLE "BudgetAlertDelivery"
  ADD CONSTRAINT "BudgetAlertDelivery_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BudgetAlertDelivery_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "BudgetAlertDelivery_tenantBudgetId_fkey"
    FOREIGN KEY ("tenantBudgetId", "organizationId")
      REFERENCES "TenantBudget"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "BudgetAlertDelivery_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "User"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "BudgetAlertDelivery"
  ADD CONSTRAINT "BudgetAlertDelivery_status_check"
    CHECK ("status" IN ('pending', 'processing', 'failed', 'dead_letter', 'delivered', 'suppressed')),
  ADD CONSTRAINT "BudgetAlertDelivery_dimension_check"
    CHECK ("dimension" IN ('quantity', 'amount')),
  ADD CONSTRAINT "BudgetAlertDelivery_threshold_check"
    CHECK ("threshold" BETWEEN 1 AND 100),
  ADD CONSTRAINT "BudgetAlertDelivery_attempts_check"
    CHECK ("attempts" >= 0),
  ADD CONSTRAINT "BudgetAlertDelivery_period_check"
    CHECK ("periodEnd" > "periodStart"),
  ADD CONSTRAINT "BudgetAlertDelivery_values_check"
    CHECK (
      ("dimension" = 'quantity' AND "actualQuantity" IS NOT NULL AND "limitQuantity" IS NOT NULL AND "currency" IS NULL) OR
      ("dimension" = 'amount' AND "actualAmountMinor" IS NOT NULL AND "limitAmountMinor" IS NOT NULL AND "currency" ~ '^[A-Z]{3}$')
    );

CREATE TABLE "BudgetAlertEvaluationIssue" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantBudgetId" TEXT NOT NULL,
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3) NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "details" JSONB,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BudgetAlertEvaluationIssue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BudgetAlertEvaluationIssue_status_check"
    CHECK ("status" IN ('active', 'resolved')),
  CONSTRAINT "BudgetAlertEvaluationIssue_occurrences_check"
    CHECK ("occurrences" > 0),
  CONSTRAINT "BudgetAlertEvaluationIssue_period_check"
    CHECK ("periodEnd" > "periodStart")
);

CREATE UNIQUE INDEX "BudgetAlertIssue_budget_period_code_key"
  ON "BudgetAlertEvaluationIssue"("tenantBudgetId", "periodStart", "code");
CREATE INDEX "BudgetAlertIssue_status_seen_idx"
  ON "BudgetAlertEvaluationIssue"("status", "lastSeenAt");
CREATE INDEX "BudgetAlertEvaluationIssue_organizationId_createdAt_idx"
  ON "BudgetAlertEvaluationIssue"("organizationId", "createdAt");

ALTER TABLE "BudgetAlertEvaluationIssue"
  ADD CONSTRAINT "BudgetAlertEvaluationIssue_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BudgetAlertEvaluationIssue_tenantBudgetId_organizationId_fkey"
    FOREIGN KEY ("tenantBudgetId", "organizationId")
      REFERENCES "TenantBudget"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;
