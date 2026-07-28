-- Compatibility bridge for 20260721213809_add_inventory. The multi-tenant
-- foundation already removed these legacy Clinic columns, while that later
-- migration drops them without IF EXISTS. On a fresh database, temporarily
-- restore empty columns so the historical migration can run unchanged.
--
-- On an existing database where the historical migration has already been
-- applied, this migration is deliberately a no-op. This preserves the
-- checksum of an applied migration while making clean installs reproducible.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE migration_name = '20260721213809_add_inventory'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  ) THEN
    ALTER TABLE "Clinic"
      ADD COLUMN IF NOT EXISTS "doctorName" TEXT,
      ADD COLUMN IF NOT EXISTS "doctorPhone" TEXT,
      ADD COLUMN IF NOT EXISTS "doctorQualification" TEXT,
      ADD COLUMN IF NOT EXISTS "doctorSpecialty" TEXT,
      ADD COLUMN IF NOT EXISTS "doctorYOE" INTEGER,
      ADD COLUMN IF NOT EXISTS "planTier" TEXT NOT NULL DEFAULT 'starter';
  END IF;
END $$;
