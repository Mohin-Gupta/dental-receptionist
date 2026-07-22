-- Multi-tenant SaaS foundation
--
-- The migration deliberately fails before adding tenant constraints if legacy
-- rows disagree about ownership. Silently reassigning those rows would risk a
-- cross-tenant disclosure, so an operator must investigate any reported row.

CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Sensitive billing and provider changes require proof that the current
-- session, not merely the user account, completed MFA.
ALTER TABLE "Session" ADD COLUMN "mfaVerifiedAt" TIMESTAMP(3);

-- One user can have only one method of a given type. Retain the most useful
-- legacy row before turning the former lookup index into a unique invariant.
WITH ranked_mfa_methods AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "userId", "type"
           ORDER BY ("enabledAt" IS NOT NULL) DESC, "createdAt" DESC, "id" DESC
         ) AS row_number
  FROM "MfaMethod"
)
DELETE FROM "MfaMethod"
WHERE "id" IN (
  SELECT "id" FROM ranked_mfa_methods WHERE row_number > 1
);

DROP INDEX IF EXISTS "MfaMethod_userId_type_idx";
CREATE UNIQUE INDEX "MfaMethod_userId_type_key" ON "MfaMethod"("userId", "type");

-- Organization owners control billing, provider credentials, and membership.
-- Require enrollment for legacy owners promoted by the earlier migration too.
UPDATE "User" u
SET "mfaRequired" = TRUE
WHERE EXISTS (
  SELECT 1
  FROM "OrganizationMembership" om
  WHERE om."userId" = u."id"
    AND om."role" = 'owner'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "DoctorClinic" dc
    JOIN "Doctor" d ON d."id" = dc."doctorId"
    JOIN "Clinic" c ON c."id" = dc."clinicId"
    WHERE d."organizationId" <> c."organizationId"
  ) THEN
    RAISE EXCEPTION 'Tenant integrity violation: DoctorClinic links organizations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "DoctorAvailability" da
    JOIN "Doctor" d ON d."id" = da."doctorId"
    JOIN "Clinic" c ON c."id" = da."clinicId"
    WHERE da."clinicId" IS NOT NULL
      AND d."organizationId" <> c."organizationId"
  ) THEN
    RAISE EXCEPTION 'Tenant integrity violation: DoctorAvailability links organizations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "CalendarConnection" cc
    LEFT JOIN "Clinic" c ON c."id" = cc."clinicId"
    LEFT JOIN "Doctor" d ON d."id" = cc."doctorId"
    WHERE (c."id" IS NOT NULL AND c."organizationId" <> cc."organizationId")
       OR (d."id" IS NOT NULL AND d."organizationId" <> cc."organizationId")
  ) THEN
    RAISE EXCEPTION 'Tenant integrity violation: CalendarConnection ownership mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "InviteToken" i
    JOIN "Clinic" c ON c."id" = i."clinicId"
    WHERE i."clinicId" IS NOT NULL
      AND i."organizationId" <> c."organizationId"
  ) THEN
    RAISE EXCEPTION 'Tenant integrity violation: InviteToken ownership mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Patient" p
    JOIN "Clinic" c ON c."id" = p."clinicId"
    WHERE p."organizationId" <> c."organizationId"
  ) THEN
    RAISE EXCEPTION 'Tenant integrity violation: Patient ownership mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Appointment" a
    JOIN "Clinic" c ON c."id" = a."clinicId"
    JOIN "Doctor" d ON d."id" = a."doctorId"
    JOIN "Patient" p ON p."id" = a."patientId"
    WHERE a."organizationId" <> c."organizationId"
       OR a."organizationId" <> d."organizationId"
       OR a."organizationId" <> p."organizationId"
  ) THEN
    RAISE EXCEPTION 'Tenant integrity violation: Appointment ownership mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "CallLog" cl
    JOIN "Clinic" c ON c."id" = cl."clinicId"
    LEFT JOIN "Patient" p ON p."id" = cl."patientId"
    LEFT JOIN "Appointment" a ON a."id" = cl."appointmentId"
    WHERE cl."organizationId" <> c."organizationId"
       OR (p."id" IS NOT NULL AND cl."organizationId" <> p."organizationId")
       OR (a."id" IS NOT NULL AND (
            cl."organizationId" <> a."organizationId"
            OR cl."clinicId" <> a."clinicId"
          ))
  ) THEN
    RAISE EXCEPTION 'Tenant integrity violation: CallLog ownership mismatch';
  END IF;
END $$;

-- Launch controls and regional defaults. Existing organizations are active;
-- newly created organizations start in provisioning.
ALTER TABLE "Organization"
  ADD COLUMN "status" TEXT,
  ADD COLUMN "dataRegion" TEXT;

UPDATE "Organization"
SET "status" = 'active',
    "dataRegion" = 'IN';

ALTER TABLE "Organization"
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'provisioning',
  ALTER COLUMN "dataRegion" SET NOT NULL,
  ALTER COLUMN "dataRegion" SET DEFAULT 'IN';

ALTER TABLE "Clinic"
  ADD COLUMN "countryCode" TEXT NOT NULL DEFAULT 'IN',
  ADD COLUMN "defaultCallingCode" TEXT NOT NULL DEFAULT '91',
  ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en-IN';

-- The multi-clinic migration copied these legacy Clinic fields into
-- Organization/Doctor but intentionally left the originals behind. They are
-- no longer part of the Prisma model and are now safe to remove.
ALTER TABLE "Clinic"
  DROP COLUMN IF EXISTS "doctorName",
  DROP COLUMN IF EXISTS "doctorPhone",
  DROP COLUMN IF EXISTS "doctorQualification",
  DROP COLUMN IF EXISTS "doctorSpecialty",
  DROP COLUMN IF EXISTS "doctorYOE",
  DROP COLUMN IF EXISTS "planTier";

-- @updatedAt is maintained by Prisma; align legacy columns with the datamodel.
ALTER TABLE "CalendarConnection" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "Clinic" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "Doctor" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "DoctorAvailability" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "Organization" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "OrganizationMembership" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Backfill explicit ownership on previously indirect tenant rows.
ALTER TABLE "ClinicMembership" ADD COLUMN "organizationId" TEXT;
UPDATE "ClinicMembership" cm
SET "organizationId" = c."organizationId"
FROM "Clinic" c
WHERE c."id" = cm."clinicId";
ALTER TABLE "ClinicMembership" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "DoctorClinic" ADD COLUMN "organizationId" TEXT;
UPDATE "DoctorClinic" dc
SET "organizationId" = d."organizationId"
FROM "Doctor" d
WHERE d."id" = dc."doctorId";
ALTER TABLE "DoctorClinic" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "DoctorAvailability" ADD COLUMN "organizationId" TEXT;
UPDATE "DoctorAvailability" da
SET "organizationId" = d."organizationId"
FROM "Doctor" d
WHERE d."id" = da."doctorId";
ALTER TABLE "DoctorAvailability" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "ReminderJob"
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "clinicId" TEXT;
UPDATE "ReminderJob" r
SET "organizationId" = a."organizationId",
    "clinicId" = a."clinicId"
FROM "Appointment" a
WHERE a."id" = r."appointmentId";
ALTER TABLE "ReminderJob"
  ALTER COLUMN "organizationId" SET NOT NULL,
  ALTER COLUMN "clinicId" SET NOT NULL;

-- Appointment command/synchronization controls. Existing Google-backed rows
-- are marked synced; rows without a provider event remain pending.
ALTER TABLE "Appointment"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "supersedesAppointmentId" TEXT,
  ADD COLUMN "calendarSyncStatus" TEXT;

-- Prisma's legacy default was TIMESTAMP WITHOUT TIME ZONE. Values were written
-- as UTC instants, so make that assumption explicit while converting to the
-- timezone-aware type required by tstzrange.
ALTER TABLE "Appointment"
  ALTER COLUMN "startAt" TYPE TIMESTAMPTZ(3)
    USING "startAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "endAt" TYPE TIMESTAMPTZ(3)
    USING "endAt" AT TIME ZONE 'UTC';

UPDATE "Appointment"
SET "calendarSyncStatus" = CASE
  WHEN "googleEventId" IS NOT NULL THEN 'synced'
  ELSE 'pending'
END;

ALTER TABLE "Appointment"
  ALTER COLUMN "calendarSyncStatus" SET NOT NULL,
  ALTER COLUMN "calendarSyncStatus" SET DEFAULT 'pending';

-- Composite candidate keys used by tenant-aware foreign keys.
CREATE UNIQUE INDEX "Clinic_id_organizationId_key"
  ON "Clinic"("id", "organizationId");
CREATE UNIQUE INDEX "Doctor_id_organizationId_key"
  ON "Doctor"("id", "organizationId");
CREATE UNIQUE INDEX "Patient_id_organizationId_key"
  ON "Patient"("id", "organizationId");
CREATE UNIQUE INDEX "Appointment_id_organizationId_key"
  ON "Appointment"("id", "organizationId");
CREATE UNIQUE INDEX "Appointment_id_organizationId_clinicId_key"
  ON "Appointment"("id", "organizationId", "clinicId");
CREATE UNIQUE INDEX "Appointment_idempotencyKey_key"
  ON "Appointment"("idempotencyKey");
CREATE UNIQUE INDEX "CallLog_id_organizationId_key"
  ON "CallLog"("id", "organizationId");
CREATE UNIQUE INDEX "DoctorClinic_organizationId_doctorId_clinicId_key"
  ON "DoctorClinic"("organizationId", "doctorId", "clinicId");

CREATE INDEX "ClinicMembership_organizationId_userId_idx"
  ON "ClinicMembership"("organizationId", "userId");
CREATE INDEX "DoctorClinic_organizationId_clinicId_idx"
  ON "DoctorClinic"("organizationId", "clinicId");
CREATE INDEX "DoctorAvailability_tenant_doctor_clinic_day_idx"
  ON "DoctorAvailability"("organizationId", "doctorId", "clinicId", "dayOfWeek");
CREATE INDEX "CallLog_organizationId_createdAt_idx"
  ON "CallLog"("organizationId", "createdAt");
CREATE INDEX "CallLog_clinicId_createdAt_idx"
  ON "CallLog"("clinicId", "createdAt");
CREATE INDEX "ReminderJob_organizationId_status_scheduledAt_idx"
  ON "ReminderJob"("organizationId", "status", "scheduledAt");
CREATE INDEX "ReminderJob_clinicId_scheduledAt_idx"
  ON "ReminderJob"("clinicId", "scheduledAt");

DROP INDEX IF EXISTS "DoctorClinic_clinicId_idx";
DROP INDEX IF EXISTS "DoctorAvailability_doctorId_clinicId_dayOfWeek_idx";

-- Replace single-column tenant-owned relations with composite ownership FKs.
ALTER TABLE "ClinicMembership" DROP CONSTRAINT IF EXISTS "ClinicMembership_clinicId_fkey";
ALTER TABLE "DoctorClinic" DROP CONSTRAINT IF EXISTS "DoctorClinic_doctorId_fkey";
ALTER TABLE "DoctorClinic" DROP CONSTRAINT IF EXISTS "DoctorClinic_clinicId_fkey";
ALTER TABLE "DoctorAvailability" DROP CONSTRAINT IF EXISTS "DoctorAvailability_doctorId_fkey";
ALTER TABLE "DoctorAvailability" DROP CONSTRAINT IF EXISTS "DoctorAvailability_clinicId_fkey";
ALTER TABLE "CalendarConnection" DROP CONSTRAINT IF EXISTS "CalendarConnection_clinicId_fkey";
ALTER TABLE "CalendarConnection" DROP CONSTRAINT IF EXISTS "CalendarConnection_doctorId_fkey";
ALTER TABLE "InviteToken" DROP CONSTRAINT IF EXISTS "InviteToken_clinicId_fkey";
ALTER TABLE "Patient" DROP CONSTRAINT IF EXISTS "Patient_clinicId_fkey";
ALTER TABLE "Appointment" DROP CONSTRAINT IF EXISTS "Appointment_clinicId_fkey";
ALTER TABLE "Appointment" DROP CONSTRAINT IF EXISTS "Appointment_doctorId_fkey";
ALTER TABLE "Appointment" DROP CONSTRAINT IF EXISTS "Appointment_patientId_fkey";
ALTER TABLE "CallLog" DROP CONSTRAINT IF EXISTS "CallLog_clinicId_fkey";
ALTER TABLE "CallLog" DROP CONSTRAINT IF EXISTS "CallLog_patientId_fkey";
ALTER TABLE "CallLog" DROP CONSTRAINT IF EXISTS "CallLog_appointmentId_fkey";
ALTER TABLE "ReminderJob" DROP CONSTRAINT IF EXISTS "ReminderJob_appointmentId_fkey";

ALTER TABLE "ClinicMembership"
  ADD CONSTRAINT "ClinicMembership_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ClinicMembership_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DoctorClinic"
  ADD CONSTRAINT "DoctorClinic_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DoctorClinic_doctorId_organizationId_fkey"
    FOREIGN KEY ("doctorId", "organizationId") REFERENCES "Doctor"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DoctorClinic_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DoctorAvailability"
  ADD CONSTRAINT "DoctorAvailability_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DoctorAvailability_doctorId_organizationId_fkey"
    FOREIGN KEY ("doctorId", "organizationId") REFERENCES "Doctor"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DoctorAvailability_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarConnection"
  ADD CONSTRAINT "CalendarConnection_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CalendarConnection_doctorId_organizationId_fkey"
    FOREIGN KEY ("doctorId", "organizationId") REFERENCES "Doctor"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InviteToken"
  ADD CONSTRAINT "InviteToken_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Patient"
  ADD CONSTRAINT "Patient_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Appointment_doctorId_organizationId_fkey"
    FOREIGN KEY ("doctorId", "organizationId") REFERENCES "Doctor"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Appointment_patientId_organizationId_fkey"
    FOREIGN KEY ("patientId", "organizationId") REFERENCES "Patient"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Appointment_supersedesAppointmentId_organizationId_fkey"
    FOREIGN KEY ("supersedesAppointmentId", "organizationId") REFERENCES "Appointment"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "CallLog"
  ADD CONSTRAINT "CallLog_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CallLog_patientId_organizationId_fkey"
    FOREIGN KEY ("patientId", "organizationId") REFERENCES "Patient"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CallLog_appointmentId_organizationId_clinicId_fkey"
    FOREIGN KEY ("appointmentId", "organizationId", "clinicId") REFERENCES "Appointment"("id", "organizationId", "clinicId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReminderJob"
  ADD CONSTRAINT "ReminderJob_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReminderJob_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReminderJob_appointmentId_organizationId_clinicId_fkey"
    FOREIGN KEY ("appointmentId", "organizationId", "clinicId") REFERENCES "Appointment"("id", "organizationId", "clinicId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Refuse to install the exclusion constraint if active legacy appointments
-- already overlap. PostgreSQL exclusion constraints cannot be NOT VALID.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Appointment"
    WHERE "status" IN ('scheduled', 'confirmed')
      AND "startAt" >= "endAt"
  ) THEN
    RAISE EXCEPTION 'Cannot add Appointment_no_active_doctor_overlap: active appointment has a non-positive duration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Appointment" a
    JOIN "Appointment" b
      ON a."organizationId" = b."organizationId"
     AND a."doctorId" = b."doctorId"
     AND a."id" < b."id"
     AND a."status" IN ('scheduled', 'confirmed')
     AND b."status" IN ('scheduled', 'confirmed')
     AND tstzrange(a."startAt", a."endAt", '[)') && tstzrange(b."startAt", b."endAt", '[)')
  ) THEN
    RAISE EXCEPTION 'Cannot add Appointment_no_active_doctor_overlap: overlapping active appointments exist';
  END IF;
END $$;

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_no_active_doctor_overlap"
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "doctorId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" IN ('scheduled', 'confirmed'));

-- Tenant-owned provider accounts and trusted resource mappings.
CREATE TABLE "ProviderAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'provisioning',
  "credentialsEncrypted" TEXT,
  "credentialKeyVersion" TEXT,
  "config" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderAccount_organizationId_provider_key"
  ON "ProviderAccount"("organizationId", "provider");
CREATE UNIQUE INDEX "ProviderAccount_provider_externalAccountId_key"
  ON "ProviderAccount"("provider", "externalAccountId");
CREATE UNIQUE INDEX "ProviderAccount_id_organizationId_key"
  ON "ProviderAccount"("id", "organizationId");
CREATE INDEX "ProviderAccount_organizationId_status_idx"
  ON "ProviderAccount"("organizationId", "status");

ALTER TABLE "ProviderAccount"
  ADD CONSTRAINT "ProviderAccount_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderResource" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "providerAccountId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "displayName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'provisioning',
  "config" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderResource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderResource_provider_resourceType_externalId_key"
  ON "ProviderResource"("provider", "resourceType", "externalId");
CREATE UNIQUE INDEX "ProviderResource_id_organizationId_key"
  ON "ProviderResource"("id", "organizationId");
CREATE INDEX "ProviderResource_organizationId_clinicId_status_idx"
  ON "ProviderResource"("organizationId", "clinicId", "status");
CREATE INDEX "ProviderResource_providerAccountId_resourceType_idx"
  ON "ProviderResource"("providerAccountId", "resourceType");

ALTER TABLE "ProviderResource"
  ADD CONSTRAINT "ProviderResource_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderResource_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderResource_providerAccountId_organizationId_fkey"
    FOREIGN KEY ("providerAccountId", "organizationId") REFERENCES "ProviderAccount"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CommunicationAttempt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "providerResourceId" TEXT,
  "patientId" TEXT,
  "appointmentId" TEXT,
  "callLogId" TEXT,
  "provider" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "externalId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "destination" TEXT,
  "origin" TEXT,
  "durationSeconds" INTEGER,
  "segmentCount" INTEGER,
  "request" JSONB,
  "response" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunicationAttempt_organizationId_idempotencyKey_key"
  ON "CommunicationAttempt"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "CommunicationAttempt_provider_externalId_key"
  ON "CommunicationAttempt"("provider", "externalId");
CREATE UNIQUE INDEX "CommunicationAttempt_id_organizationId_key"
  ON "CommunicationAttempt"("id", "organizationId");
CREATE INDEX "CommunicationAttempt_tenant_channel_createdAt_idx"
  ON "CommunicationAttempt"("organizationId", "clinicId", "channel", "createdAt");
CREATE INDEX "CommunicationAttempt_organizationId_status_createdAt_idx"
  ON "CommunicationAttempt"("organizationId", "status", "createdAt");

ALTER TABLE "CommunicationAttempt"
  ADD CONSTRAINT "CommunicationAttempt_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CommunicationAttempt_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CommunicationAttempt_providerResourceId_organizationId_fkey"
    FOREIGN KEY ("providerResourceId", "organizationId") REFERENCES "ProviderResource"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CommunicationAttempt_patientId_organizationId_fkey"
    FOREIGN KEY ("patientId", "organizationId") REFERENCES "Patient"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CommunicationAttempt_appointmentId_organizationId_fkey"
    FOREIGN KEY ("appointmentId", "organizationId") REFERENCES "Appointment"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "CommunicationAttempt_callLogId_organizationId_fkey"
    FOREIGN KEY ("callLogId", "organizationId") REFERENCES "CallLog"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "ProviderWebhookEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "providerAccountId" TEXT,
  "providerResourceId" TEXT,
  "communicationAttemptId" TEXT,
  "provider" TEXT NOT NULL,
  "externalEventId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "signatureValid" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB NOT NULL,
  "headers" JSONB,
  "response" JSONB,
  "status" TEXT NOT NULL DEFAULT 'received',
  "processingAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderWebhookEvent_provider_idempotencyKey_key"
  ON "ProviderWebhookEvent"("provider", "idempotencyKey");
CREATE INDEX "ProviderWebhookEvent_provider_externalEventId_idx"
  ON "ProviderWebhookEvent"("provider", "externalEventId");
CREATE INDEX "ProviderWebhookEvent_status_receivedAt_idx"
  ON "ProviderWebhookEvent"("status", "receivedAt");
CREATE INDEX "ProviderWebhookEvent_organizationId_receivedAt_idx"
  ON "ProviderWebhookEvent"("organizationId", "receivedAt");

ALTER TABLE "ProviderWebhookEvent"
  ADD CONSTRAINT "ProviderWebhookEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderWebhookEvent_providerAccountId_organizationId_fkey"
    FOREIGN KEY ("providerAccountId", "organizationId") REFERENCES "ProviderAccount"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderWebhookEvent_providerResourceId_organizationId_fkey"
    FOREIGN KEY ("providerResourceId", "organizationId") REFERENCES "ProviderResource"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderWebhookEvent_communicationAttemptId_organizationId_fkey"
    FOREIGN KEY ("communicationAttemptId", "organizationId") REFERENCES "CommunicationAttempt"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "PriceVersion" (
  "id" TEXT NOT NULL,
  "planKey" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "unitAmountMinor" BIGINT NOT NULL,
  "unitQuantity" DECIMAL(20,6) NOT NULL DEFAULT 1,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PriceVersion_planKey_metric_version_currency_key"
  ON "PriceVersion"("planKey", "metric", "version", "currency");
CREATE INDEX "PriceVersion_planKey_metric_effectiveFrom_idx"
  ON "PriceVersion"("planKey", "metric", "effectiveFrom");

CREATE TABLE "BillingAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "billingProvider" TEXT NOT NULL,
  "externalCustomerId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "billingEmail" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "taxIds" JSONB,
  "billingAddress" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingAccount_organizationId_key"
  ON "BillingAccount"("organizationId");
CREATE UNIQUE INDEX "BillingAccount_billingProvider_externalCustomerId_key"
  ON "BillingAccount"("billingProvider", "externalCustomerId");
CREATE UNIQUE INDEX "BillingAccount_id_organizationId_key"
  ON "BillingAccount"("id", "organizationId");
CREATE INDEX "BillingAccount_status_idx" ON "BillingAccount"("status");

ALTER TABLE "BillingAccount"
  ADD CONSTRAINT "BillingAccount_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SubscriptionMirror" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "billingAccountId" TEXT NOT NULL,
  "billingProvider" TEXT NOT NULL,
  "externalSubscriptionId" TEXT NOT NULL,
  "planKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "trialEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "canceledAt" TIMESTAMP(3),
  "graceUntil" TIMESTAMP(3),
  "providerPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionMirror_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionMirror_billingProvider_externalSubscriptionId_key"
  ON "SubscriptionMirror"("billingProvider", "externalSubscriptionId");
CREATE UNIQUE INDEX "SubscriptionMirror_id_organizationId_key"
  ON "SubscriptionMirror"("id", "organizationId");
CREATE INDEX "SubscriptionMirror_organizationId_status_idx"
  ON "SubscriptionMirror"("organizationId", "status");
CREATE INDEX "SubscriptionMirror_currentPeriodEnd_idx"
  ON "SubscriptionMirror"("currentPeriodEnd");

ALTER TABLE "SubscriptionMirror"
  ADD CONSTRAINT "SubscriptionMirror_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SubscriptionMirror_billingAccountId_organizationId_fkey"
    FOREIGN KEY ("billingAccountId", "organizationId") REFERENCES "BillingAccount"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Entitlement" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "subscriptionMirrorId" TEXT,
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "limit" DECIMAL(20,6),
  "unit" TEXT,
  "value" JSONB,
  "source" TEXT NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Entitlement_organizationId_key_key"
  ON "Entitlement"("organizationId", "key");
CREATE INDEX "Entitlement_organizationId_enabled_expiresAt_idx"
  ON "Entitlement"("organizationId", "enabled", "expiresAt");

ALTER TABLE "Entitlement"
  ADD CONSTRAINT "Entitlement_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Entitlement_subscriptionMirrorId_organizationId_fkey"
    FOREIGN KEY ("subscriptionMirrorId", "organizationId") REFERENCES "SubscriptionMirror"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "TenantBudget" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "metric" TEXT NOT NULL,
  "period" TEXT NOT NULL DEFAULT 'monthly',
  "currency" TEXT,
  "softLimitQuantity" DECIMAL(20,6),
  "hardLimitQuantity" DECIMAL(20,6),
  "softLimitAmountMinor" BIGINT,
  "hardLimitAmountMinor" BIGINT,
  "enforcementMode" TEXT NOT NULL DEFAULT 'alert',
  "alertThresholds" JSONB,
  "status" TEXT NOT NULL DEFAULT 'active',
  "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantBudget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TenantBudget_organizationId_metric_status_idx"
  ON "TenantBudget"("organizationId", "metric", "status");
CREATE INDEX "TenantBudget_clinicId_metric_idx"
  ON "TenantBudget"("clinicId", "metric");

ALTER TABLE "TenantBudget"
  ADD CONSTRAINT "TenantBudget_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TenantBudget_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReconciliationRun" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "localEventCount" INTEGER NOT NULL DEFAULT 0,
  "providerEventCount" INTEGER NOT NULL DEFAULT 0,
  "differenceQuantity" DECIMAL(20,6),
  "differenceAmountMicros" BIGINT,
  "currency" TEXT,
  "summary" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReconciliationRun_id_organizationId_key"
  ON "ReconciliationRun"("id", "organizationId");
CREATE INDEX "ReconciliationRun_tenant_provider_window_idx"
  ON "ReconciliationRun"("organizationId", "provider", "windowStart", "windowEnd");
CREATE INDEX "ReconciliationRun_status_createdAt_idx"
  ON "ReconciliationRun"("status", "createdAt");

ALTER TABLE "ReconciliationRun"
  ADD CONSTRAINT "ReconciliationRun_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Customer-facing usage and actual provider costs are intentionally separate,
-- append-only ledgers so retail pricing and gross margin remain auditable.
CREATE TABLE "UsageEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "providerResourceId" TEXT,
  "communicationAttemptId" TEXT,
  "priceVersionId" TEXT,
  "correctionOfId" TEXT,
  "metric" TEXT NOT NULL,
  "quantity" DECIMAL(20,6) NOT NULL,
  "unit" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "externalEventId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "ratedAmountMinor" BIGINT,
  "currency" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageEvent_organizationId_idempotencyKey_key"
  ON "UsageEvent"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "UsageEvent_id_organizationId_key"
  ON "UsageEvent"("id", "organizationId");
CREATE INDEX "UsageEvent_organizationId_metric_occurredAt_idx"
  ON "UsageEvent"("organizationId", "metric", "occurredAt");
CREATE INDEX "UsageEvent_organizationId_status_occurredAt_idx"
  ON "UsageEvent"("organizationId", "status", "occurredAt");
CREATE INDEX "UsageEvent_providerResourceId_occurredAt_idx"
  ON "UsageEvent"("providerResourceId", "occurredAt");

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UsageEvent_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UsageEvent_providerResourceId_organizationId_fkey"
    FOREIGN KEY ("providerResourceId", "organizationId") REFERENCES "ProviderResource"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "UsageEvent_communicationAttemptId_organizationId_fkey"
    FOREIGN KEY ("communicationAttemptId", "organizationId") REFERENCES "CommunicationAttempt"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "UsageEvent_priceVersionId_fkey"
    FOREIGN KEY ("priceVersionId") REFERENCES "PriceVersion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "UsageEvent_correctionOfId_organizationId_fkey"
    FOREIGN KEY ("correctionOfId", "organizationId") REFERENCES "UsageEvent"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "ProviderCostEntry" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "providerResourceId" TEXT,
  "communicationAttemptId" TEXT,
  "usageEventId" TEXT,
  "reconciliationRunId" TEXT,
  "provider" TEXT NOT NULL,
  "costType" TEXT NOT NULL,
  "quantity" DECIMAL(20,6),
  "unit" TEXT,
  "amountMicros" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "externalEventId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCostEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderCostEntry_provider_idempotencyKey_key"
  ON "ProviderCostEntry"("provider", "idempotencyKey");
CREATE INDEX "ProviderCostEntry_organizationId_provider_occurredAt_idx"
  ON "ProviderCostEntry"("organizationId", "provider", "occurredAt");
CREATE INDEX "ProviderCostEntry_organizationId_costType_occurredAt_idx"
  ON "ProviderCostEntry"("organizationId", "costType", "occurredAt");

ALTER TABLE "ProviderCostEntry"
  ADD CONSTRAINT "ProviderCostEntry_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderCostEntry_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderCostEntry_providerResourceId_organizationId_fkey"
    FOREIGN KEY ("providerResourceId", "organizationId") REFERENCES "ProviderResource"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderCostEntry_communicationAttemptId_organizationId_fkey"
    FOREIGN KEY ("communicationAttemptId", "organizationId") REFERENCES "CommunicationAttempt"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderCostEntry_usageEventId_organizationId_fkey"
    FOREIGN KEY ("usageEventId", "organizationId") REFERENCES "UsageEvent"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProviderCostEntry_reconciliationRunId_organizationId_fkey"
    FOREIGN KEY ("reconciliationRunId", "organizationId") REFERENCES "ReconciliationRun"("id", "organizationId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "UsageExport" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "usageEventId" TEXT NOT NULL,
  "billingProvider" TEXT NOT NULL,
  "externalEventId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB,
  "response" JSONB,
  "lastError" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "exportedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsageExport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageExport_billingProvider_idempotencyKey_key"
  ON "UsageExport"("billingProvider", "idempotencyKey");
CREATE INDEX "UsageExport_organizationId_status_createdAt_idx"
  ON "UsageExport"("organizationId", "status", "createdAt");
CREATE INDEX "UsageExport_usageEventId_idx"
  ON "UsageExport"("usageEventId");

ALTER TABLE "UsageExport"
  ADD CONSTRAINT "UsageExport_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UsageExport_usageEventId_organizationId_fkey"
    FOREIGN KEY ("usageEventId", "organizationId") REFERENCES "UsageEvent"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clinicId" TEXT,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutboxEvent_organizationId_idempotencyKey_key"
  ON "OutboxEvent"("organizationId", "idempotencyKey");
CREATE INDEX "OutboxEvent_status_availableAt_idx"
  ON "OutboxEvent"("status", "availableAt");
CREATE INDEX "OutboxEvent_organizationId_aggregateType_aggregateId_idx"
  ON "OutboxEvent"("organizationId", "aggregateType", "aggregateId");

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OutboxEvent_clinicId_organizationId_fkey"
    FOREIGN KEY ("clinicId", "organizationId") REFERENCES "Clinic"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;
