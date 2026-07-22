import { setPatientName, TenantCallScope } from './state';

interface StoreNameParameters {
  letters?: unknown;
}

export async function storeName(
  clinicId: string,
  callId: string,
  parameters: StoreNameParameters
): Promise<string> {
  const scope: TenantCallScope = { clinicId, callId };
  const letters = parameters?.letters;

  if (typeof letters !== 'string' || !letters.trim()) {
    return 'The name was missing. Ask the patient to spell their name clearly, then call storeName again.';
  }

  const cleanLetters = letters
    .trim()
    .toUpperCase()
    .replace(/\bSPACE\b/gi, '|')
    .replace(/[^A-Z|]/g, '')
    .split('|')
    .map((word: string) => {
      if (word.length === 0) return '';
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter((w: string) => w.length > 0)
    .join(' ')
    .trim();

  if (!cleanLetters) {
    return 'The name could not be understood. Ask the patient to spell it again, one word at a time.';
  }

  try {
    await setPatientName(scope, cleanLetters);
  } catch (error) {
    console.error(
      'Unable to persist call name:',
      error instanceof Error ? error.message : 'unknown Redis error'
    );
    return 'I could not safely retain the name. Apologise and tell the patient a team member will call them back.';
  }

  return `Name stored as "${cleanLetters}". Say: "Got it — ${cleanLetters}. Is that right?" If yes proceed. If no ask to spell again and call storeName.`;
}
