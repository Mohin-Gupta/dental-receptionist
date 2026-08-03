import { setPatientName, TenantCallScope } from './state';
import { fail, ok, ToolResponse } from './toolResponse';

interface StoreNameParameters {
  letters?: unknown;
}

export async function storeName(
  clinicId: string,
  callId: string,
  parameters: StoreNameParameters
): Promise<ToolResponse> {
  const scope: TenantCallScope = { clinicId, callId };
  const letters = parameters?.letters;

  if (typeof letters !== 'string' || !letters.trim()) {
    return fail(
      'NAME_MISSING',
      'No name was provided. Ask the patient, in their current language, to spell their name clearly, then call storeName again.'
    );
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
    return fail(
      'NAME_UNCLEAR',
      'The spelled name could not be understood. Ask the patient, in their current language, to spell it again one word at a time.'
    );
  }

  try {
    await setPatientName(scope, cleanLetters);
  } catch (error) {
    console.error(
      'Unable to persist call name:',
      error instanceof Error ? error.message : 'unknown Redis error'
    );
    return fail(
      'STORAGE_ERROR',
      'The name could not be safely retained. Apologise to the patient in their current language and tell them a team member will call them back.'
    );
  }

  return ok(
    'NAME_STORED',
    'Read data.name back to the patient naturally in their current language and ask them to confirm it is correct. If they say it is wrong, ask them to spell the full name again and call storeName again.',
    { name: cleanLetters }
  );
}
