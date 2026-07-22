ALTER TABLE "CommunicationAttempt" ADD COLUMN "usageFinalizedAt" TIMESTAMP(3);
CREATE INDEX "CommunicationAttempt_usageFinalizedAt_updatedAt_idx"
  ON "CommunicationAttempt"("usageFinalizedAt", "updatedAt");
