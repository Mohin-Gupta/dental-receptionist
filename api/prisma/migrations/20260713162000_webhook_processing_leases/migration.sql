ALTER TABLE "ProviderWebhookEvent"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3);

DROP INDEX "ProviderWebhookEvent_status_receivedAt_idx";

CREATE INDEX "ProviderWebhookEvent_status_processingStartedAt_receivedAt_idx"
  ON "ProviderWebhookEvent"("status", "processingStartedAt", "receivedAt");
