-- Existing static-assistant phone mappings have not passed the dynamic
-- assistant-request admission verification. Fail closed until an owner or
-- operator reactivates them through the verified provisioning path.
UPDATE "ProviderResource" AS resource
SET "status" = 'provisioning',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "ProviderAccount" AS account
WHERE resource."providerAccountId" = account."id"
  AND resource."organizationId" = account."organizationId"
  AND resource."provider" = 'vapi'
  AND resource."status" = 'active'
  AND COALESCE(account."config"->>'credentialSource', 'tenant') <> 'platform';

UPDATE "ProviderResource"
SET "status" = 'provisioning',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'vapi'
  AND "resourceType" = 'phone_number'
  AND "status" = 'active'
  AND COALESCE("config"->>'direction', 'both') <> 'outbound'
  AND (
    COALESCE(NULLIF("config"->>'inboundAssistantId', ''), '') = ''
    OR COALESCE(NULLIF("config"->>'admissionVerifiedAt', ''), '') = ''
  );

-- Future scripts and backfills must use the same fail-closed invariant as the
-- application. Cross-resource assistant ownership is checked by the service;
-- this constraint guarantees that an active inbound row at least carries the
-- verified mapping and admission marker required by the request resolver.
ALTER TABLE "ProviderResource"
  ADD CONSTRAINT "ProviderResource_active_vapi_inbound_admission_check"
  CHECK (
    "provider" <> 'vapi'
    OR "resourceType" <> 'phone_number'
    OR "status" <> 'active'
    OR COALESCE("config"->>'direction', 'both') = 'outbound'
    OR (
      COALESCE(NULLIF("config"->>'inboundAssistantId', ''), '') <> ''
      AND COALESCE(NULLIF("config"->>'admissionVerifiedAt', ''), '') <> ''
    )
  );
