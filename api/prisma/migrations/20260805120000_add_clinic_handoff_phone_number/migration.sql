-- AlterTable
-- Adds the clinic-configured human-handoff (call transfer) destination number.
-- Nullable: existing clinics have no handoff number configured until a staff
-- member sets one in Settings, and the feature degrades gracefully when unset.
ALTER TABLE "Clinic" ADD COLUMN "handoffPhoneNumber" TEXT;
