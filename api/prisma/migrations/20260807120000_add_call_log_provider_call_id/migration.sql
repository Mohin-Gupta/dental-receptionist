-- AlterTable
-- Adds a generic, provider-agnostic call identifier column for non-Vapi
-- providers (starting with Bolna), so they don't have to repurpose or rename
-- the existing Vapi-branded vapiCallId column out from under working Vapi
-- code paths. Purely additive: nullable, unique, no backfill, no changes to
-- any existing row or query.
ALTER TABLE "CallLog" ADD COLUMN "providerCallId" TEXT;
CREATE UNIQUE INDEX "CallLog_providerCallId_key" ON "CallLog"("providerCallId");
