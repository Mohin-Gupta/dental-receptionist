CREATE TABLE "OrganizationRegistrationRequest" (
  "id" TEXT NOT NULL,
  "idempotencyKeyHash" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "userId" TEXT,
  "organizationId" TEXT,
  "clinicId" TEXT,
  "verificationDeliveryStatus" TEXT NOT NULL DEFAULT 'pending',
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationRegistrationRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationRegistrationRequest_idempotencyKeyHash_key"
  ON "OrganizationRegistrationRequest"("idempotencyKeyHash");
CREATE INDEX "OrganizationRegistrationRequest_status_createdAt_idx"
  ON "OrganizationRegistrationRequest"("status", "createdAt");
CREATE INDEX "OrganizationRegistrationRequest_organizationId_idx"
  ON "OrganizationRegistrationRequest"("organizationId");
