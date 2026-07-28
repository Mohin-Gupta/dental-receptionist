-- Expand phase: old API replicas write mfaVerifiedAt without a method during
-- a rolling deploy, so the new provenance column must initially stay nullable.
-- New replicas always write both fields. A later contract migration can clear
-- legacy method-less proofs and tighten this check after every old replica has
-- drained.
ALTER TABLE "Session"
  ADD COLUMN "mfaVerifiedMethod" TEXT;

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_mfa_verification_pair_check"
  CHECK (
    ("mfaVerifiedAt" IS NULL AND "mfaVerifiedMethod" IS NULL)
    OR
    (
      "mfaVerifiedAt" IS NOT NULL
      AND ("mfaVerifiedMethod" IS NULL OR "mfaVerifiedMethod" IN ('totp', 'recovery_code'))
    )
  );

-- Recovery-code metadata is safe to expose as counts/timestamps; raw codes
-- remain one-time values and only their hashes are persisted.
ALTER TABLE "MfaMethod"
  ADD COLUMN "recoveryCodesGeneratedAt" TIMESTAMP(3),
  ADD COLUMN "lastRecoveryCodeUsedAt" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "MfaMethod"
SET "recoveryCodesGeneratedAt" = COALESCE("enabledAt", "createdAt")
WHERE jsonb_typeof("recoveryCodes") = 'array';

-- Keep the default for rolling-deploy compatibility: an old API replica does
-- not know about updatedAt and must still be able to insert an MFA method.

-- The compound candidate key lets PostgreSQL prove that a challenge's session
-- belongs to the same user, rather than relying on application code alone.
CREATE UNIQUE INDEX "Session_id_userId_key" ON "Session"("id", "userId");

-- A replacement secret lives in a separate, session-bound challenge. The
-- current authenticator remains valid until challenge activation succeeds.
CREATE TABLE "MfaEnrollmentChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MfaEnrollmentChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MfaEnrollmentChallenge_purpose_check" CHECK ("purpose" IN ('enroll', 'replace')),
  CONSTRAINT "MfaEnrollmentChallenge_attempts_check" CHECK ("attemptCount" >= 0 AND "attemptCount" <= 5),
  CONSTRAINT "MfaEnrollmentChallenge_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "MfaEnrollmentChallenge_userId_key"
  ON "MfaEnrollmentChallenge"("userId");
CREATE INDEX "MfaEnrollmentChallenge_sessionId_idx"
  ON "MfaEnrollmentChallenge"("sessionId");
CREATE INDEX "MfaEnrollmentChallenge_expiresAt_idx"
  ON "MfaEnrollmentChallenge"("expiresAt");

ALTER TABLE "MfaEnrollmentChallenge"
  ADD CONSTRAINT "MfaEnrollmentChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MfaEnrollmentChallenge"
  ADD CONSTRAINT "MfaEnrollmentChallenge_sessionId_userId_fkey"
  FOREIGN KEY ("sessionId", "userId") REFERENCES "Session"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
