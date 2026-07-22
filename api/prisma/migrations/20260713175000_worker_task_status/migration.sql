CREATE TABLE "WorkerTaskStatus" (
  "name" TEXT NOT NULL,
  "workerName" TEXT NOT NULL,
  "expectedMaxAgeSeconds" INTEGER NOT NULL,
  "lastStartedAt" TIMESTAMP(3) NOT NULL,
  "lastSucceededAt" TIMESTAMP(3),
  "lastFailedAt" TIMESTAMP(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerTaskStatus_pkey" PRIMARY KEY ("name"),
  CONSTRAINT "WorkerTaskStatus_expected_age_check" CHECK ("expectedMaxAgeSeconds" > 0),
  CONSTRAINT "WorkerTaskStatus_failure_count_check" CHECK ("consecutiveFailures" >= 0)
);

CREATE INDEX "WorkerTaskStatus_workerName_lastSucceededAt_idx"
  ON "WorkerTaskStatus"("workerName", "lastSucceededAt");
