import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { authenticator } from 'otplib';
import { prisma } from '../src/lib/prisma';
import { generateToken, hashPassword, hashToken } from '../src/auth/crypto';
import { decryptSecret, encryptSecret } from '../src/auth/secretBox';
import {
  generateRecoveryCodes,
  hasFreshMfaTimestamp,
  MfaServiceError,
  recoveryCodeMatches,
  recoveryCodesRemaining,
  disableMfa,
  regenerateRecoveryCodes,
  startMfaEnrollment,
  verifyMfaEnrollment,
} from '../src/auth/mfaService';

test('MFA freshness is bounded by the configured sensitive-action window', () => {
  const previous = process.env.MFA_SENSITIVE_WINDOW_MINUTES;
  process.env.MFA_SENSITIVE_WINDOW_MINUTES = '30';
  const now = new Date('2026-07-23T12:00:00.000Z');
  assert.equal(hasFreshMfaTimestamp(new Date('2026-07-23T11:30:00.000Z'), now), true);
  assert.equal(hasFreshMfaTimestamp(new Date('2026-07-23T11:29:59.999Z'), now), false);
  assert.equal(hasFreshMfaTimestamp(null, now), false);
  if (previous === undefined) delete process.env.MFA_SENSITIVE_WINDOW_MINUTES;
  else process.env.MFA_SENSITIVE_WINDOW_MINUTES = previous;
});

test('recovery codes are high-entropy, unique, hashed, and countable', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every(code => code.length >= 22));
  const hashes = codes.map(hashToken);
  assert.equal(recoveryCodesRemaining(hashes), 10);
  assert.equal(recoveryCodeMatches(hashes, codes[4]), true);
  assert.equal(recoveryCodeMatches(hashes, generateToken(16)), false);
  assert.ok(hashes.every(hash => !codes.includes(hash)));
});

const runDatabaseTests = process.env.RUN_MFA_DATABASE_TESTS === 'true';
const createdUserIds: string[] = [];

async function createMfaFixture(options: { mfaRequired?: boolean } = {}) {
  const password = `correct-horse-${generateToken(10)}`;
  const user = await prisma.user.create({
    data: {
      email: `mfa-${generateToken(12)}@example.test`,
      name: 'MFA Integration Test',
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
      status: 'active',
      mfaRequired: options.mfaRequired ?? true,
    },
  });
  createdUserIds.push(user.id);
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(generateToken()),
      csrfTokenHash: hashToken(generateToken()),
      mfaVerifiedAt: new Date(),
      mfaVerifiedMethod: 'totp',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const activeSecret = authenticator.generateSecret();
  const method = await prisma.mfaMethod.create({
    data: {
      userId: user.id,
      type: 'totp',
      secret: encryptSecret(activeSecret, `mfa:totp:${user.id}`),
      enabledAt: new Date(),
      recoveryCodes: [hashToken(generateToken(16))],
      recoveryCodesGeneratedAt: new Date(),
    },
  });
  return {
    user,
    session,
    method,
    password,
    activeSecret,
    context: { userId: user.id, sessionId: session.id },
  };
}

test('a pending replacement preserves the active authenticator until verification', {
  skip: !runDatabaseTests,
}, async () => {
  const fixture = await createMfaFixture();
  const enrollment = await startMfaEnrollment({
    context: fixture.context,
    password: fixture.password,
    purpose: 'replace',
  });
  const unchanged = await prisma.mfaMethod.findUniqueOrThrow({ where: { id: fixture.method.id } });
  assert.equal(
    decryptSecret(unchanged.secret!, `mfa:totp:${fixture.user.id}`),
    fixture.activeSecret
  );
  assert.ok(unchanged.enabledAt);
  const challenge = await prisma.mfaEnrollmentChallenge.findUnique({
    where: { id: enrollment.enrollmentId },
  });
  assert.equal(challenge?.sessionId, fixture.session.id);
});

test('replacement activation is atomic and only one concurrent verifier succeeds', {
  skip: !runDatabaseTests,
}, async () => {
  const fixture = await createMfaFixture();
  const enrollment = await startMfaEnrollment({
    context: fixture.context,
    password: fixture.password,
    purpose: 'replace',
  });
  const code = authenticator.generate(enrollment.secret);
  const attempts = await Promise.allSettled([
    verifyMfaEnrollment({
      context: fixture.context,
      enrollmentId: enrollment.enrollmentId,
      code,
    }),
    verifyMfaEnrollment({
      context: fixture.context,
      enrollmentId: enrollment.enrollmentId,
      code,
    }),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = attempts.find(result => result.status === 'rejected');
  assert.ok(rejection && rejection.status === 'rejected');
  assert.ok(rejection.reason instanceof MfaServiceError);

  const method = await prisma.mfaMethod.findUniqueOrThrow({ where: { id: fixture.method.id } });
  assert.equal(decryptSecret(method.secret!, `mfa:totp:${fixture.user.id}`), enrollment.secret);
  assert.equal(recoveryCodesRemaining(method.recoveryCodes), 10);
  assert.equal(
    await prisma.mfaEnrollmentChallenge.count({ where: { userId: fixture.user.id } }),
    0
  );
  const session = await prisma.session.findUniqueOrThrow({ where: { id: fixture.session.id } });
  assert.equal(session.mfaVerifiedMethod, 'totp');
});

test('an invalid pending code preserves the active authenticator and recovery codes', {
  skip: !runDatabaseTests,
}, async () => {
  const fixture = await createMfaFixture();
  const enrollment = await startMfaEnrollment({
    context: fixture.context,
    password: fixture.password,
    purpose: 'replace',
  });
  const validCode = authenticator.generate(enrollment.secret);
  const invalidCode = validCode === '000000' ? '000001' : '000000';

  await assert.rejects(
    verifyMfaEnrollment({
      context: fixture.context,
      enrollmentId: enrollment.enrollmentId,
      code: invalidCode,
    }),
    (error: unknown) => error instanceof MfaServiceError && error.code === 'invalid_mfa_code'
  );

  const method = await prisma.mfaMethod.findUniqueOrThrow({ where: { id: fixture.method.id } });
  assert.equal(decryptSecret(method.secret!, `mfa:totp:${fixture.user.id}`), fixture.activeSecret);
  assert.deepEqual(method.recoveryCodes, fixture.method.recoveryCodes);
  const challenge = await prisma.mfaEnrollmentChallenge.findUniqueOrThrow({
    where: { id: enrollment.enrollmentId },
  });
  assert.equal(challenge.attemptCount, 1);
});

test('an expired replacement is deleted without changing the active authenticator', {
  skip: !runDatabaseTests,
}, async () => {
  const fixture = await createMfaFixture();
  const enrollment = await startMfaEnrollment({
    context: fixture.context,
    password: fixture.password,
    purpose: 'replace',
  });
  const challenge = await prisma.mfaEnrollmentChallenge.findUniqueOrThrow({
    where: { id: enrollment.enrollmentId },
  });
  const expiredAt = new Date(Date.now() - 60_000);
  await prisma.mfaEnrollmentChallenge.update({
    where: { id: challenge.id },
    data: {
      createdAt: new Date(expiredAt.getTime() - 60_000),
      expiresAt: expiredAt,
    },
  });

  await assert.rejects(
    verifyMfaEnrollment({
      context: fixture.context,
      enrollmentId: enrollment.enrollmentId,
      code: authenticator.generate(enrollment.secret),
    }),
    (error: unknown) => error instanceof MfaServiceError && error.code === 'mfa_enrollment_expired'
  );
  const method = await prisma.mfaMethod.findUniqueOrThrow({ where: { id: fixture.method.id } });
  assert.equal(decryptSecret(method.secret!, `mfa:totp:${fixture.user.id}`), fixture.activeSecret);
  assert.equal(await prisma.mfaEnrollmentChallenge.count({ where: { id: challenge.id } }), 0);
});

test('concurrent recovery-code regeneration returns only one authoritative set', {
  skip: !runDatabaseTests,
}, async () => {
  const fixture = await createMfaFixture();
  const code = authenticator.generate(fixture.activeSecret);
  const attempts = await Promise.allSettled([
    regenerateRecoveryCodes({ context: fixture.context, password: fixture.password, code }),
    regenerateRecoveryCodes({ context: fixture.context, password: fixture.password, code }),
  ]);

  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = attempts.find(result => result.status === 'rejected');
  assert.ok(rejection && rejection.status === 'rejected');
  assert.ok(rejection.reason instanceof MfaServiceError);
  assert.equal(rejection.reason.code, 'mfa_state_changed');

  const successful = attempts.find(result => result.status === 'fulfilled');
  assert.ok(successful && successful.status === 'fulfilled');
  const method = await prisma.mfaMethod.findUniqueOrThrow({ where: { id: fixture.method.id } });
  assert.ok(successful.value.every(recoveryCode => recoveryCodeMatches(method.recoveryCodes, recoveryCode)));
  assert.equal(method.version, 1);
});

test('required accounts cannot disable MFA', { skip: !runDatabaseTests }, async () => {
  const fixture = await createMfaFixture();
  await assert.rejects(
    disableMfa({
      context: fixture.context,
      password: fixture.password,
      code: authenticator.generate(fixture.activeSecret),
    }),
    (error: unknown) => error instanceof MfaServiceError && error.code === 'mfa_required_by_policy'
  );
  assert.ok(await prisma.mfaMethod.findUnique({ where: { id: fixture.method.id } }));
});

test('disabling optional MFA removes the method and revokes every session', {
  skip: !runDatabaseTests,
}, async () => {
  const fixture = await createMfaFixture({ mfaRequired: false });
  await prisma.session.create({
    data: {
      userId: fixture.user.id,
      tokenHash: hashToken(generateToken()),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const revoked = await disableMfa({
    context: fixture.context,
    password: fixture.password,
    code: authenticator.generate(fixture.activeSecret),
  });
  assert.equal(revoked, 2);
  assert.equal(await prisma.mfaMethod.count({ where: { userId: fixture.user.id } }), 0);
  assert.equal(await prisma.session.count({
    where: { userId: fixture.user.id, revokedAt: null },
  }), 0);
});

after(async () => {
  if (runDatabaseTests && createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});
