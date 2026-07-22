/**
 * Metrics the application can currently emit into the append-only usage
 * ledger. A plan may omit paths its entitlements cannot invoke, but catalogs
 * and tenant budgets must not reference metrics no production path can record.
 */
export const USAGE_METRICS = {
  VOICE_SECONDS: 'voice_seconds',
  SMS_SEGMENTS: 'sms_segments',
  VAPI_LLM_PROMPT_TOKENS: 'vapi_llm_prompt_tokens',
  VAPI_LLM_CACHED_PROMPT_TOKENS: 'vapi_llm_cached_prompt_tokens',
  VAPI_LLM_COMPLETION_TOKENS: 'vapi_llm_completion_tokens',
  VAPI_TTS_CHARACTERS: 'vapi_tts_characters',
} as const;

export const USAGE_METRIC_VALUES = [
  USAGE_METRICS.VOICE_SECONDS,
  USAGE_METRICS.SMS_SEGMENTS,
  USAGE_METRICS.VAPI_LLM_PROMPT_TOKENS,
  USAGE_METRICS.VAPI_LLM_CACHED_PROMPT_TOKENS,
  USAGE_METRICS.VAPI_LLM_COMPLETION_TOKENS,
  USAGE_METRICS.VAPI_TTS_CHARACTERS,
] as const;

export type UsageMetric = (typeof USAGE_METRIC_VALUES)[number];

/** Metrics that can be conservatively reserved before provider dispatch. */
export const RESERVABLE_USAGE_METRIC_VALUES: readonly UsageMetric[] = [
  USAGE_METRICS.VOICE_SECONDS,
  USAGE_METRICS.SMS_SEGMENTS,
];

export const VOICE_USAGE_METRIC_VALUES: readonly UsageMetric[] = [
  USAGE_METRICS.VOICE_SECONDS,
  USAGE_METRICS.VAPI_LLM_PROMPT_TOKENS,
  USAGE_METRICS.VAPI_LLM_CACHED_PROMPT_TOKENS,
  USAGE_METRICS.VAPI_LLM_COMPLETION_TOKENS,
  USAGE_METRICS.VAPI_TTS_CHARACTERS,
];

export function isUsageMetric(value: string): value is UsageMetric {
  return (USAGE_METRIC_VALUES as readonly string[]).includes(value);
}
