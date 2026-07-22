ALTER TABLE "Clinic"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Clinic_organizationId_status_idx"
  ON "Clinic"("organizationId", "status");
