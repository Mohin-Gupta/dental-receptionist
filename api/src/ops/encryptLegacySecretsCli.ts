import 'dotenv/config';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../auth/secretBox';
import { prisma } from '../lib/prisma';

const BATCH_SIZE = 250;
const APPLY_FLAG = '--apply';
const DRY_RUN_FLAG = '--dry-run';

type MigrationMode = 'dry-run' | 'apply';

type SecretMigrationSummary = {
  scanned: number;
  alreadyEncrypted: number;
  plaintextFound: number;
  encrypted: number;
  concurrentChanges: number;
  missingPurpose: number;
};

function emptySummary(): SecretMigrationSummary {
  return {
    scanned: 0,
    alreadyEncrypted: 0,
    plaintextFound: 0,
    encrypted: 0,
    concurrentChanges: 0,
    missingPurpose: 0,
  };
}

function parseMode(argv: string[]): MigrationMode {
  if (argv.includes('--help')) {
    console.log(
      'Usage: npm run security:encrypt-legacy-secrets -- [--dry-run | --apply]\n' +
        'Defaults to --dry-run. --apply encrypts only values that are still identical to the scanned plaintext.'
    );
    process.exit(0);
  }

  const unknown = argv.filter(argument => argument !== APPLY_FLAG && argument !== DRY_RUN_FLAG);
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
  }
  if (argv.includes(APPLY_FLAG) && argv.includes(DRY_RUN_FLAG)) {
    throw new Error('Choose either --dry-run or --apply, not both');
  }
  return argv.includes(APPLY_FLAG) ? 'apply' : 'dry-run';
}

function assertEncryptionKeyringCanWrite() {
  const purpose = 'legacy-secret-encryption-cli:configuration-check';
  const probe = `probe-${Date.now()}`;
  const ciphertext = encryptSecret(probe, purpose);
  if (!isEncryptedSecret(ciphertext)) {
    throw new Error(
      'Refusing to apply: DATA_ENCRYPTION_KEYS and DATA_ENCRYPTION_ACTIVE_KEY_ID must configure an active encryption key'
    );
  }
  if (decryptSecret(ciphertext, purpose) !== probe) {
    throw new Error('Refusing to apply: the active data-encryption key failed its round-trip check');
  }
}

function calendarPurpose(organizationId: string, ownerId: string): string {
  return `calendar:${organizationId}:${ownerId}`;
}

function mfaPurpose(userId: string): string {
  return `mfa:totp:${userId}`;
}

async function migrateClinicTokens(mode: MigrationMode): Promise<SecretMigrationSummary> {
  const summary = emptySummary();
  let cursor: string | undefined;

  while (true) {
    const rows = await prisma.clinic.findMany({
      where: { googleTokens: { not: null } },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, organizationId: true, googleTokens: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      const plaintext = row.googleTokens!;
      if (isEncryptedSecret(plaintext)) {
        summary.alreadyEncrypted += 1;
        continue;
      }

      summary.plaintextFound += 1;
      if (mode === 'dry-run') continue;

      const result = await prisma.clinic.updateMany({
        where: { id: row.id, googleTokens: plaintext },
        data: {
          googleTokens: encryptSecret(
            plaintext,
            calendarPurpose(row.organizationId, row.id)
          ),
        },
      });
      if (result.count === 1) summary.encrypted += 1;
      else summary.concurrentChanges += 1;
    }

    cursor = rows[rows.length - 1].id;
  }

  return summary;
}

async function migrateCalendarConnections(mode: MigrationMode): Promise<SecretMigrationSummary> {
  const summary = emptySummary();
  let cursor: string | undefined;

  while (true) {
    const rows = await prisma.calendarConnection.findMany({
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        organizationId: true,
        clinicId: true,
        doctorId: true,
        googleTokens: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      if (isEncryptedSecret(row.googleTokens)) {
        summary.alreadyEncrypted += 1;
        continue;
      }

      summary.plaintextFound += 1;
      // This mirrors googleCalendar.ts, which gives a doctor connection
      // precedence if legacy data contains both IDs. With neither ID there is
      // no stable AAD purpose, so fail safely instead of creating unreadable data.
      const ownerId = row.doctorId ?? row.clinicId;
      if (!ownerId) {
        summary.missingPurpose += 1;
        continue;
      }
      if (mode === 'dry-run') continue;

      const result = await prisma.calendarConnection.updateMany({
        where: { id: row.id, googleTokens: row.googleTokens },
        data: {
          googleTokens: encryptSecret(
            row.googleTokens,
            calendarPurpose(row.organizationId, ownerId)
          ),
        },
      });
      if (result.count === 1) summary.encrypted += 1;
      else summary.concurrentChanges += 1;
    }

    cursor = rows[rows.length - 1].id;
  }

  return summary;
}

async function migrateMfaSecrets(mode: MigrationMode): Promise<SecretMigrationSummary> {
  const summary = emptySummary();
  let cursor: string | undefined;

  while (true) {
    const rows = await prisma.mfaMethod.findMany({
      where: { secret: { not: null } },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, userId: true, type: true, secret: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      const plaintext = row.secret!;
      if (isEncryptedSecret(plaintext)) {
        summary.alreadyEncrypted += 1;
        continue;
      }

      summary.plaintextFound += 1;
      if (row.type !== 'totp') {
        // TOTP is the only secret-bearing MFA method currently consumed by the
        // application. Do not invent AAD for a future/unknown method type.
        summary.missingPurpose += 1;
        continue;
      }
      if (mode === 'dry-run') continue;

      const result = await prisma.mfaMethod.updateMany({
        where: { id: row.id, secret: plaintext },
        data: { secret: encryptSecret(plaintext, mfaPurpose(row.userId)) },
      });
      if (result.count === 1) summary.encrypted += 1;
      else summary.concurrentChanges += 1;
    }

    cursor = rows[rows.length - 1].id;
  }

  return summary;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'apply') assertEncryptionKeyringCanWrite();

  const results = {
    clinics: await migrateClinicTokens(mode),
    calendarConnections: await migrateCalendarConnections(mode),
    mfaMethods: await migrateMfaSecrets(mode),
  };
  const unresolved = Object.values(results).reduce(
    (total, result) => total + result.concurrentChanges + result.missingPurpose,
    0
  );

  console.log('Legacy secret encryption scan complete', { mode, ...results });

  if (unresolved > 0) {
    throw new Error(
      `${unresolved} row(s) were not safely migrated; repair missing encryption-purpose data or rerun after concurrent writes finish`
    );
  }
}

main()
  .catch(error => {
    console.error('Legacy secret encryption failed', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown error',
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
