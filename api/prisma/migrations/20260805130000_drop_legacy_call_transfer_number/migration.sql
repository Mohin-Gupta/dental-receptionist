-- AlterTable
-- Removes a stray column left over from a migration that was applied to
-- production and then reverted out of the codebase (via a commit reset)
-- before it could be rolled back. The column was never present in
-- schema.prisma after the reset, so this migration exists purely to bring
-- the database back in sync with the tracked schema. Superseded by
-- handoffPhoneNumber (see 20260805120000_add_clinic_handoff_phone_number).
ALTER TABLE "Clinic" DROP COLUMN IF EXISTS "callTransferNumber";
