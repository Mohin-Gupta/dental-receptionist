/**
 * Normalize a phone number for identity comparison and provider calls.
 *
 * This deliberately avoids suffix matching: two countries can have the same
 * national number. Existing local-format records are interpreted using the
 * clinic's configured calling code and should be migrated to E.164 over time.
 */
export function toE164(raw: string, defaultCallingCode = '91'): string {
  const value = raw.trim();
  const digits = value.replace(/\D/g, '');
  if (!digits) throw new Error('Phone number is required');

  const asE164 = (number: string): string => {
    // E.164 permits at most 15 digits and never begins with a zero. Requiring a
    // plausible minimum also keeps malformed caller identifiers out of identity
    // comparisons without pretending to validate every country's numbering plan.
    if (!/^[1-9]\d{6,14}$/.test(number)) {
      throw new Error('Phone number is not valid E.164');
    }
    return `+${number}`;
  };

  if (value.startsWith('+')) return asE164(digits);
  if (value.startsWith('00')) return asE164(digits.slice(2));

  const country = defaultCallingCode.replace(/\D/g, '');
  if (!/^[1-9]\d{0,2}$/.test(country)) {
    throw new Error('Default calling code is invalid');
  }

  // Legacy records in this product contain ten-digit Indian national numbers.
  // Strip one or more national trunk-prefix zeroes. Values longer than ten
  // digits that already start with the clinic calling code are retained for
  // backward compatibility with country-code-prefixed records lacking "+".
  const national = digits.replace(/^0+/, '');
  const normalized = digits.length > 10 && digits.startsWith(country)
    ? digits
    : `${country}${national}`;
  return asE164(normalized);
}

export function phonesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
  defaultCallingCode = '91'
): boolean {
  if (!left || !right) return false;
  try {
    return toE164(left, defaultCallingCode) === toE164(right, defaultCallingCode);
  } catch {
    return false;
  }
}

export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}
