CREATE TABLE "CommunicationPreference" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "channel" TEXT NOT NULL,
  "addressHash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "lastProviderEventId" TEXT,
  "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunicationPreference_organizationId_channel_addressHash_key"
  ON "CommunicationPreference"("organizationId", "channel", "addressHash");
CREATE INDEX "CommunicationPreference_organizationId_channel_status_idx"
  ON "CommunicationPreference"("organizationId", "channel", "status");
CREATE INDEX "CommunicationPreference_clinicId_updatedAt_idx"
  ON "CommunicationPreference"("clinicId", "updatedAt");

ALTER TABLE "CommunicationPreference"
  ADD CONSTRAINT "CommunicationPreference_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CommunicationPreference_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;
