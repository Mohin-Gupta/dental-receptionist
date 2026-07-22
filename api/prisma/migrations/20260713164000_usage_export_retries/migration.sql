ALTER TABLE "UsageExport"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

DROP INDEX "UsageExport_organizationId_status_createdAt_idx";

CREATE INDEX "UsageExport_status_nextAttemptAt_organizationId_createdAt_idx"
  ON "UsageExport"("status", "nextAttemptAt", "organizationId", "createdAt");
