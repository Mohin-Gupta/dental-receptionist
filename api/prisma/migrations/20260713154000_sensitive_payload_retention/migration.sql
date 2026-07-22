ALTER TABLE "CallLog" ADD COLUMN "transcriptPurgedAt" TIMESTAMP(3);
ALTER TABLE "CommunicationAttempt" ADD COLUMN "payloadPurgedAt" TIMESTAMP(3);
ALTER TABLE "ProviderWebhookEvent" ADD COLUMN "payloadPurgedAt" TIMESTAMP(3);

CREATE INDEX "ProviderWebhookEvent_payloadPurgedAt_receivedAt_idx"
  ON "ProviderWebhookEvent"("payloadPurgedAt", "receivedAt");
CREATE INDEX "CommunicationAttempt_payloadPurgedAt_createdAt_idx"
  ON "CommunicationAttempt"("payloadPurgedAt", "createdAt");
CREATE INDEX "CallLog_transcriptPurgedAt_createdAt_idx"
  ON "CallLog"("transcriptPurgedAt", "createdAt");
