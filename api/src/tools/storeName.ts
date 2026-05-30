import { nameCache } from './state';

export function storeName(callId: string, parameters: any): string {
  const { letters } = parameters;
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

  nameCache[callId] = cleanLetters;
  console.log(`Name stored: "${letters}" → "${cleanLetters}"`);
  return `Name stored as "${cleanLetters}". Say: "Got it — ${cleanLetters}. Is that right?" If yes proceed. If no ask to spell again and call storeName.`;
}