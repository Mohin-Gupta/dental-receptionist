ALTER TABLE "UsageEvent"
  ADD COLUMN "ratedAmountSubminor" DECIMAL(38,12);

-- Exact fractional minor-unit data was not retained historically. Preserve the
-- old rounded value for existing rows; all new events write the exact amount.
UPDATE "UsageEvent"
SET "ratedAmountSubminor" = "ratedAmountMinor"::DECIMAL(38,12)
WHERE "ratedAmountMinor" IS NOT NULL;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_rating_status_check"
    CHECK (
      ("status" = 'rated' AND "priceVersionId" IS NOT NULL AND "ratedAmountSubminor" IS NOT NULL AND "currency" IS NOT NULL) OR
      ("status" = 'unrated' AND "priceVersionId" IS NULL AND "ratedAmountSubminor" IS NULL) OR
      "status" NOT IN ('rated', 'unrated')
    ) NOT VALID;
