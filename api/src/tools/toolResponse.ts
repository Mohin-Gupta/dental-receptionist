/**
 * Shared response contract for every Vapi-facing tool.
 *
 * The old design returned a hand-written English sentence per tool ("Say
 * EXACTLY: ..."), which meant every tool response was implicitly English-only
 * — Hindi/Hinglish callers were always one translation layer removed from the
 * facts. This design instead returns:
 *
 *   - `data`  → language-neutral facts only (ISO dates, 24h times, names,
 *               ids, counts). Never pre-rendered into any language.
 *   - `code`  → a stable machine-readable status the assistant (and, if
 *               useful, telemetry/tests) can branch on without parsing prose.
 *   - `say`   → English guidance *to the assistant* on what to do with
 *               `data` and how to phrase it. This is instructions for the
 *               model, not a script — the system prompt tells the model to
 *               express the underlying facts naturally in whatever language
 *               (English/Hindi/Hinglish) the caller is currently using, and
 *               to never alter a fact while doing so.
 *
 * The whole object is JSON-stringified into Vapi's required `result: string`
 * field (Vapi does not accept a JSON object there — only a single-line
 * string), so the model receives valid, parseable JSON as the tool result.
 */

import { parseInTimezone } from '../lib/timezone';

export interface ToolResponse<TData extends Record<string, unknown> = Record<string, unknown>> {
  /** Whether the requested operation succeeded. */
  ok: boolean;
  /** Stable machine-readable status, e.g. "SLOTS_AVAILABLE", "NAME_STORED". */
  code: string;
  /** Language-neutral facts: ISO dates, 24h times, names, ids, counts, etc. */
  data: TData;
  /**
   * English guidance for the assistant on how to respond. Never meant to be
   * spoken verbatim — the assistant must express the underlying `data` in
   * the caller's current language (English/Hindi/Hinglish) while preserving
   * every fact exactly.
   */
  say: string;
}

export function toolResult<TData extends Record<string, unknown>>(
  ok: boolean,
  code: string,
  say: string,
  data: TData = {} as TData
): ToolResponse<TData> {
  return { ok, code, data, say };
}

export function ok<TData extends Record<string, unknown>>(
  code: string,
  say: string,
  data: TData = {} as TData
): ToolResponse<TData> {
  return toolResult(true, code, say, data);
}

export function fail<TData extends Record<string, unknown>>(
  code: string,
  say: string,
  data: TData = {} as TData
): ToolResponse<TData> {
  return toolResult(false, code, say, data);
}

/** First name only, for warm/personal address — language-neutral. */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || 'there';
}

/** Splits a clinic-local Date into ISO date + 24h time, with no language baked in. */
export function isoDateAndTime(date: Date, timezone: string): { date: string; time: string } {
  const { year, month, day, hour, minute } = parseInTimezone(date.toISOString(), timezone);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
  };
}
