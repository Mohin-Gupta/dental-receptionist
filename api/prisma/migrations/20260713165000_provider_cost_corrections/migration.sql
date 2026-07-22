ALTER TABLE "ProviderCostEntry"
  ADD COLUMN "correctionOfId" TEXT;

CREATE UNIQUE INDEX "ProviderCostEntry_id_organizationId_key"
  ON "ProviderCostEntry"("id", "organizationId");

CREATE INDEX "ProviderCostEntry_correctionOfId_idx"
  ON "ProviderCostEntry"("correctionOfId");

ALTER TABLE "ProviderCostEntry"
  ADD CONSTRAINT "ProviderCostEntry_correctionOfId_organizationId_fkey"
    FOREIGN KEY ("correctionOfId", "organizationId")
    REFERENCES "ProviderCostEntry"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;
