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

  // The whole point of this tool is that the booked name is exactly what the
  // patient spelled — never a whole word the model heard or "cleaned up" on
  // its own. To enforce that, every whitespace-separated token must be a
  // single letter, except the literal word "space" marking a word boundary.
  // A token like "Mohind" (a full word, not spelled out) is rejected here
  // rather than silently accepted, even if it happens to be a plausible name.
  const rawTokens = letters.trim().split(/\s+/);
  let hasMultiLetterToken = false;
  let singleLetterCount = 0;
  for (const token of rawTokens) {
    if (/^space$/i.test(token)) continue;
    const alphaOnly = token.replace(/[^A-Za-z]/g, '');
    if (alphaOnly.length === 0) continue;
    if (alphaOnly.length === 1) {
      singleLetterCount += 1;
    } else {
      hasMultiLetterToken = true;
    }
  }

  if (hasMultiLetterToken || singleLetterCount < 2) {
    return fail(
      'NAME_NOT_SPELLED_OUT',
      'The name must be given strictly letter by letter, not as a spoken word or repeated name — never substitute what you think the name sounds like. Ask the patient, in their current language, to spell their full name one letter at a time (e.g. "M... O... H... A... N..."), then call storeName again with exactly those letters.'
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
      'The spelled name could not be understood. Ask the patient, in their current language, to spell it again one letter at a time.'
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
    'Read data.name back to the patient naturally in their current language and ask them to confirm it is correct. If they say it is wrong, ask them to spell the full name again, letter by letter, and call storeName again with exactly what they spell — never with your own guess of the correct spelling.',
    { name: cleanLetters }
  );
}

