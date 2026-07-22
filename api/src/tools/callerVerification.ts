import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { phonesMatch } from '../lib/phone';
import { sendSMS } from '../services/twilio';
import {
  clearCallerVerification,
  consumeCallerVerificationCode,
  getCallerVerification,
  setCallerVerification,
} from './state';

const requestSchema = z.object({
  patientName: z.string().trim().min(2).max(120),
}).strict();
const verifySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
}).strict();
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export const CALLER_VERIFICATION_REQUIRED =
  'Strong verification is required before revealing or changing an appointment. Use requestCallerVerification to send a one-time code to the patient number on file, then use verifyCallerCode. If verification is unavailable, offer a clinic callback.';

function verificationSecret(): string {
  const secret = process.env.CALLER_VERIFICATION_HMAC_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('CALLER_VERIFICATION_HMAC_SECRET is required in production');
  }
  return secret ?? 'development-caller-verification-secret-change-me';
}

function codeDigest(clinicId: string, callId: string, patientId: string, code: string): string {
  return crypto
    .createHmac('sha256', verificationSecret())
    .update(`${clinicId}\0${callId}\0${patientId}\0${code}`)
    .digest('hex');
}

export async function requestCallerVerification(
  clinicId: string,
  callId: string,
  parameters: unknown,
  callerNumber?: string
): Promise<string> {
  const parsed = requestSchema.safeParse(parameters);
  if (!parsed.success || !callerNumber) return CALLER_VERIFICATION_REQUIRED;
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { organizationId: true, defaultCallingCode: true },
  });
  if (!clinic) return CALLER_VERIFICATION_REQUIRED;

  const candidates = await prisma.patient.findMany({
    where: {
      organizationId: clinic.organizationId,
      name: { contains: parsed.data.patientName, mode: 'insensitive' },
      appointments: {
        some: {
          clinicId,
          status: { in: ['scheduled', 'confirmed'] },
          startAt: { gte: new Date() },
        },
      },
    },
    select: { id: true, phone: true },
    take: 20,
  });
  const matching = candidates.filter(patient =>
    phonesMatch(callerNumber, patient.phone, clinic.defaultCallingCode)
  );
  // Ambiguous names/numbers and missing patients deliberately share the same
  // response; do not create an enumeration or OTP-spam endpoint.
  if (matching.length !== 1) return CALLER_VERIFICATION_REQUIRED;
  const patient = matching[0];
  const scope = { clinicId, callId };
  const existing = await getCallerVerification(scope);
  if (
    existing?.patientId === patient.id &&
    new Date(existing.expiresAt).getTime() > Date.now()
  ) {
    return existing.verifiedAt
      ? 'The caller is already strongly verified for this patient.'
      : 'A verification code was already sent to the patient number on file. Ask for that six-digit code.';
  }

  const code = String(crypto.randomInt(100_000, 1_000_000));
  const digest = codeDigest(clinicId, callId, patient.id, code);
  await setCallerVerification(scope, {
    patientId: patient.id,
    codeDigest: digest,
    expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    attempts: 0,
    verifiedAt: null,
  });
  try {
    await sendSMS(
      {
        organizationId: clinic.organizationId,
        clinicId,
        patientId: patient.id,
        idempotencyKey: `call:${callId}:patient-verification:${digest.slice(0, 16)}`,
        purpose: 'caller_verification',
        defaultCallingCode: clinic.defaultCallingCode,
      },
      patient.phone,
      `Your dental appointment verification code is ${code}. It expires in 10 minutes. Do not share it. Reply STOP to opt out.`
    );
  } catch {
    await clearCallerVerification(scope).catch(() => undefined);
    return 'Verification could not be delivered. Do not reveal or change appointment details; offer a clinic callback.';
  }
  return 'A six-digit verification code was sent to the patient number on file. Ask the caller to read it back, then use verifyCallerCode.';
}

export async function verifyCallerCode(
  clinicId: string,
  callId: string,
  parameters: unknown
): Promise<string> {
  const parsed = verifySchema.safeParse(parameters);
  if (!parsed.success) return 'Ask for the complete six-digit verification code.';
  const scope = { clinicId, callId };
  const state = await getCallerVerification(scope);
  if (!state) {
    return 'Verification is unavailable or expired. Do not reveal or change appointment details; offer a clinic callback.';
  }
  const supplied = codeDigest(clinicId, callId, state.patientId, parsed.data.code);
  const result = await consumeCallerVerificationCode(scope, supplied, MAX_ATTEMPTS);
  if (result === 'verified') {
    return 'The caller is strongly verified. You may now use findAppointment, cancelAppointment, or rescheduleAppointment for this patient.';
  }
  if (result === 'invalid') return 'That code is not valid. Ask the caller to try again.';
  if (result === 'locked') {
    return 'Verification failed too many times. Do not reveal or change appointment details; offer a clinic callback.';
  }
  return 'Verification is unavailable or expired. Do not reveal or change appointment details; offer a clinic callback.';
}

export async function isVerifiedCallPatient(
  clinicId: string,
  callId: string,
  patientId: string
): Promise<boolean> {
  const state = await getCallerVerification({ clinicId, callId });
  return Boolean(
    state &&
    state.patientId === patientId &&
    state.verifiedAt &&
    new Date(state.expiresAt).getTime() > Date.now()
  );
}
