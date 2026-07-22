interface PreferenceHmacKey {
  id: string;
  value: Buffer;
}

function decodeKey(id: string, encoded: unknown): PreferenceHmacKey {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || typeof encoded !== 'string') {
    throw new Error('Communication preference HMAC keyring is invalid');
  }
  const value = Buffer.from(encoded, 'base64');
  if (value.length !== 32 || value.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error(`Communication preference HMAC key ${id} must be Base64-encoded 32 bytes`);
  }
  return { id, value };
}

export function getCommunicationPreferenceHmacKeyring(): {
  active: PreferenceHmacKey;
  keys: PreferenceHmacKey[];
} {
  const raw = process.env.COMMUNICATION_PREFERENCE_HMAC_KEYS;
  const activeId = process.env.COMMUNICATION_PREFERENCE_HMAC_ACTIVE_KEY_ID;
  if (!raw || !activeId) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Communication preference HMAC keyring is required in production');
    }
    const development = {
      id: 'development',
      value: Buffer.from('development-preference-key-32b!', 'utf8'),
    };
    return { active: development, keys: [development] };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('COMMUNICATION_PREFERENCE_HMAC_KEYS must contain valid JSON');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('COMMUNICATION_PREFERENCE_HMAC_KEYS must be a JSON object');
  }
  const keys = Object.entries(decoded).map(([id, value]) => decodeKey(id, value));
  if (keys.length < 1 || keys.length > 10) {
    throw new Error('Communication preference HMAC keyring must contain 1 to 10 keys');
  }
  const active = keys.find(key => key.id === activeId);
  if (!active) {
    throw new Error('COMMUNICATION_PREFERENCE_HMAC_ACTIVE_KEY_ID is not present in the keyring');
  }
  return { active, keys };
}
