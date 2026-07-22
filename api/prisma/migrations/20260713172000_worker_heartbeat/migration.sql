CREATE TABLE "WorkerHeartbeat" (
  "name" TEXT NOT NULL,
  "lastStartedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx"
  ON "WorkerHeartbeat"("lastSeenAt");
