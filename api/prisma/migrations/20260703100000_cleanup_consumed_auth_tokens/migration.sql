DELETE FROM "InviteToken"
WHERE "acceptedAt" IS NOT NULL
   OR "expiresAt" <= CURRENT_TIMESTAMP;

DELETE FROM "PasswordResetToken"
WHERE "usedAt" IS NOT NULL
   OR "expiresAt" <= CURRENT_TIMESTAMP;

DELETE FROM "EmailVerificationToken"
WHERE "usedAt" IS NOT NULL
   OR "expiresAt" <= CURRENT_TIMESTAMP;
