-- Create parent organization table.
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "about" TEXT,
    "services" JSONB,
    "planTier" TEXT NOT NULL DEFAULT 'starter',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- Make existing Clinic rows become branch/location rows under a new organization.
ALTER TABLE "Clinic" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

INSERT INTO "Organization" (
    "id",
    "name",
    "phone",
    "email",
    "website",
    "about",
    "services",
    "planTier",
    "createdAt",
    "updatedAt"
)
SELECT
    'org_' || "id",
    "name",
    "phone",
    "clinicEmail",
    "clinicWebsite",
    "clinicAbout",
    "clinicServices",
    "planTier",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "Clinic";

UPDATE "Clinic" SET "organizationId" = 'org_' || "id";
ALTER TABLE "Clinic" ALTER COLUMN "organizationId" SET NOT NULL;

DROP INDEX IF EXISTS "Clinic_phone_key";
CREATE UNIQUE INDEX "Clinic_organizationId_phone_key" ON "Clinic"("organizationId", "phone");
CREATE INDEX "Clinic_organizationId_idx" ON "Clinic"("organizationId");

ALTER TABLE "Clinic"
ADD CONSTRAINT "Clinic_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Organization-level access.
CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

INSERT INTO "OrganizationMembership" (
    "id",
    "userId",
    "organizationId",
    "role",
    "createdAt",
    "updatedAt"
)
SELECT
    'orgmem_' || cm."id",
    cm."userId",
    c."organizationId",
    cm."role",
    cm."createdAt",
    CURRENT_TIMESTAMP
FROM "ClinicMembership" cm
JOIN "Clinic" c ON c."id" = cm."clinicId"
WHERE cm."role" = 'owner';

CREATE UNIQUE INDEX "OrganizationMembership_userId_organizationId_key"
ON "OrganizationMembership"("userId", "organizationId");

CREATE INDEX "OrganizationMembership_organizationId_role_idx"
ON "OrganizationMembership"("organizationId", "role");

ALTER TABLE "OrganizationMembership"
ADD CONSTRAINT "OrganizationMembership_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganizationMembership"
ADD CONSTRAINT "OrganizationMembership_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Doctors and branch assignments.
CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "qualification" TEXT,
    "yearsExperience" INTEGER,
    "specialty" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Doctor" (
    "id",
    "organizationId",
    "name",
    "phone",
    "email",
    "qualification",
    "yearsExperience",
    "specialty",
    "createdAt",
    "updatedAt"
)
SELECT
    'doctor_' || "id",
    "organizationId",
    COALESCE("doctorName", "name" || ' Doctor'),
    "doctorPhone",
    "clinicEmail",
    "doctorQualification",
    "doctorYOE",
    "doctorSpecialty",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "Clinic";

CREATE UNIQUE INDEX "Doctor_userId_key" ON "Doctor"("userId");
CREATE INDEX "Doctor_organizationId_status_idx" ON "Doctor"("organizationId", "status");

ALTER TABLE "Doctor"
ADD CONSTRAINT "Doctor_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Doctor"
ADD CONSTRAINT "Doctor_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DoctorClinic" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DoctorClinic_pkey" PRIMARY KEY ("id")
);

INSERT INTO "DoctorClinic" ("id", "doctorId", "clinicId", "createdAt")
SELECT 'doctorclinic_' || "id", 'doctor_' || "id", "id", CURRENT_TIMESTAMP
FROM "Clinic";

CREATE UNIQUE INDEX "DoctorClinic_doctorId_clinicId_key"
ON "DoctorClinic"("doctorId", "clinicId");

CREATE INDEX "DoctorClinic_clinicId_idx" ON "DoctorClinic"("clinicId");

ALTER TABLE "DoctorClinic"
ADD CONSTRAINT "DoctorClinic_doctorId_fkey"
FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DoctorClinic"
ADD CONSTRAINT "DoctorClinic_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DoctorAvailability" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "clinicId" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "open" TEXT NOT NULL,
    "close" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DoctorAvailability_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DoctorAvailability_doctorId_clinicId_dayOfWeek_idx"
ON "DoctorAvailability"("doctorId", "clinicId", "dayOfWeek");

ALTER TABLE "DoctorAvailability"
ADD CONSTRAINT "DoctorAvailability_doctorId_fkey"
FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DoctorAvailability"
ADD CONSTRAINT "DoctorAvailability_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Calendar connections. Existing clinic tokens become branch-level fallback connections.
CREATE TABLE "CalendarConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clinicId" TEXT,
    "doctorId" TEXT,
    "scope" TEXT NOT NULL,
    "googleCalendarId" TEXT,
    "googleTokens" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

INSERT INTO "CalendarConnection" (
    "id",
    "organizationId",
    "clinicId",
    "doctorId",
    "scope",
    "googleCalendarId",
    "googleTokens",
    "createdAt",
    "updatedAt"
)
SELECT
    'cal_clinic_' || "id",
    "organizationId",
    "id",
    NULL,
    'clinic',
    "googleCalendarId",
    "googleTokens",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Clinic"
WHERE "googleTokens" IS NOT NULL;

CREATE INDEX "CalendarConnection_organizationId_scope_idx"
ON "CalendarConnection"("organizationId", "scope");

CREATE INDEX "CalendarConnection_clinicId_idx" ON "CalendarConnection"("clinicId");
CREATE INDEX "CalendarConnection_doctorId_idx" ON "CalendarConnection"("doctorId");

ALTER TABLE "CalendarConnection"
ADD CONSTRAINT "CalendarConnection_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarConnection"
ADD CONSTRAINT "CalendarConnection_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarConnection"
ADD CONSTRAINT "CalendarConnection_doctorId_fkey"
FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Organization-aware patient, appointment, call, invite, and audit data.
ALTER TABLE "Patient" ADD COLUMN "organizationId" TEXT;
UPDATE "Patient" p
SET "organizationId" = c."organizationId"
FROM "Clinic" c
WHERE c."id" = p."clinicId";
ALTER TABLE "Patient" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX IF EXISTS "Patient_clinicId_phone_key";
CREATE UNIQUE INDEX "Patient_organizationId_phone_key" ON "Patient"("organizationId", "phone");
CREATE INDEX "Patient_clinicId_idx" ON "Patient"("clinicId");

ALTER TABLE "Patient"
ADD CONSTRAINT "Patient_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Appointment" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "doctorId" TEXT;
UPDATE "Appointment" a
SET
    "organizationId" = c."organizationId",
    "doctorId" = 'doctor_' || a."clinicId"
FROM "Clinic" c
WHERE c."id" = a."clinicId";
ALTER TABLE "Appointment" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Appointment" ALTER COLUMN "doctorId" SET NOT NULL;
CREATE INDEX "Appointment_organizationId_startAt_idx" ON "Appointment"("organizationId", "startAt");
CREATE INDEX "Appointment_doctorId_startAt_idx" ON "Appointment"("doctorId", "startAt");

ALTER TABLE "Appointment"
ADD CONSTRAINT "Appointment_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Appointment"
ADD CONSTRAINT "Appointment_doctorId_fkey"
FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CallLog" ADD COLUMN "organizationId" TEXT;
UPDATE "CallLog" cl
SET "organizationId" = c."organizationId"
FROM "Clinic" c
WHERE c."id" = cl."clinicId";
ALTER TABLE "CallLog" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "CallLog"
ADD CONSTRAINT "CallLog_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InviteToken" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "InviteToken" ADD COLUMN "organizationRole" TEXT;
ALTER TABLE "InviteToken" ADD COLUMN "clinicRole" TEXT;
UPDATE "InviteToken" i
SET
    "organizationId" = c."organizationId",
    "organizationRole" = CASE WHEN i."role" = 'owner' THEN i."role" ELSE NULL END,
    "clinicRole" = CASE WHEN i."role" = 'owner' THEN NULL ELSE i."role" END
FROM "Clinic" c
WHERE c."id" = i."clinicId";
ALTER TABLE "InviteToken" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "InviteToken" ALTER COLUMN "clinicId" DROP NOT NULL;
CREATE INDEX "InviteToken_organizationId_email_idx" ON "InviteToken"("organizationId", "email");

ALTER TABLE "InviteToken"
ADD CONSTRAINT "InviteToken_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD COLUMN "organizationId" TEXT;
UPDATE "AuditLog" a
SET "organizationId" = c."organizationId"
FROM "Clinic" c
WHERE c."id" = a."clinicId";
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

ALTER TABLE "AuditLog"
ADD CONSTRAINT "AuditLog_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SecurityEvent" ADD COLUMN "organizationId" TEXT;
UPDATE "SecurityEvent" s
SET "organizationId" = c."organizationId"
FROM "Clinic" c
WHERE c."id" = s."clinicId";

ALTER TABLE "SecurityEvent"
ADD CONSTRAINT "SecurityEvent_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
