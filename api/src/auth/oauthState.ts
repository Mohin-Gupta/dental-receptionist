import crypto from 'crypto';
import { redis } from '../lib/redis';
import { generateToken, safeTokenEqual } from './crypto';

type OAuthStatePayload = {
  provider: 'google';
  organizationId: string;
  clinicId: string;
  doctorId?: string;
  userId: string;
  sessionId: string;
  nonce: string;
  expiresAt: number;
};

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const CONSUME_NONCE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value or value ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

function oauthStateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('OAUTH_STATE_SECRET is required in production');
  }
  return secret ?? 'development-oauth-state-secret-change-me';
}

function sign(encodedPayload: string): string {
  return crypto.createHmac('sha256', oauthStateSecret()).update(encodedPayload).digest('base64url');
}

export async function createGoogleOAuthState(input: {
  organizationId: string;
  clinicId: string;
  doctorId?: string;
  userId: string;
  sessionId: string;
}): Promise<string> {
  const payload: OAuthStatePayload = {
    provider: 'google',
    ...input,
    nonce: generateToken(18),
    expiresAt: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  await redis.set(
    `oauth:google:${payload.nonce}`,
    payload.sessionId,
    'EX',
    OAUTH_STATE_TTL_SECONDS,
    'NX'
  );
  return `${encoded}.${sign(encoded)}`;
}

export async function consumeGoogleOAuthState(
  state: string,
  input: { userId: string; sessionId: string }
): Promise<OAuthStatePayload> {
  const [encoded, suppliedSignature] = state.split('.');
  if (!encoded || !suppliedSignature || !safeTokenEqual(sign(encoded), suppliedSignature)) {
    throw new Error('Invalid OAuth state');
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    throw new Error('Invalid OAuth state');
  }

  if (
    payload.provider !== 'google' ||
    payload.userId !== input.userId ||
    payload.sessionId !== input.sessionId ||
    payload.expiresAt <= Date.now()
  ) {
    throw new Error('OAuth state is expired or does not match this session');
  }

  const redisKey = `oauth:google:${payload.nonce}`;
  const consumed = Number(await redis.eval(
    CONSUME_NONCE_SCRIPT,
    1,
    redisKey,
    input.sessionId
  ));
  if (consumed !== 1) {
    throw new Error('OAuth state has already been used or expired');
  }
  return payload;
}
