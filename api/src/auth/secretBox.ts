import crypto from 'crypto';

type Keyring = {
  activeKeyId: string;
  keys: Record<string, Buffer>;
};

let warnedAboutDevFallback = false;

function loadKeyring(): Keyring | null {
  const serialized = process.env.DATA_ENCRYPTION_KEYS;
  const activeKeyId = process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID;

  if (!serialized || !activeKeyId) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DATA_ENCRYPTION_KEYS and DATA_ENCRYPTION_ACTIVE_KEY_ID are required in production'
      );
    }
    if (!warnedAboutDevFallback) {
      warnedAboutDevFallback = true;
      console.warn('Data encryption keyring is not configured; secrets remain plaintext in development only.');
    }
    return null;
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(serialized) as Record<string, string>;
  } catch {
    throw new Error('DATA_ENCRYPTION_KEYS must be a JSON object of keyId to base64 key');
  }

  const keys: Record<string, Buffer> = {};
  for (const [keyId, encoded] of Object.entries(parsed)) {
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) {
      throw new Error(`Data encryption key ${keyId} must decode to exactly 32 bytes`);
    }
    keys[keyId] = key;
  }

  if (!keys[activeKeyId]) {
    throw new Error('DATA_ENCRYPTION_ACTIVE_KEY_ID does not exist in DATA_ENCRYPTION_KEYS');
  }

  return { activeKeyId, keys };
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith('enc:v1:');
}

export function encryptSecret(plaintext: string, purpose: string): string {
  const keyring = loadKeyring();
  if (!keyring) return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyring.keys[keyring.activeKeyId], iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'enc',
    'v1',
    keyring.activeKeyId,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSecret(stored: string, purpose: string): string {
  if (!isEncryptedSecret(stored)) return stored;

  const [, version, keyId, ivEncoded, tagEncoded, ciphertextEncoded] = stored.split(':');
  if (version !== 'v1' || !keyId || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error('Encrypted secret has an invalid format');
  }

  const keyring = loadKeyring();
  const key = keyring?.keys[keyId];
  if (!key) throw new Error(`Encryption key ${keyId} is unavailable`);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivEncoded, 'base64url'));
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
