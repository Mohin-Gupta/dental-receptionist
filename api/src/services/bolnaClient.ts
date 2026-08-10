/**
 * Thin client for Bolna's own REST API. Mirrors the raw-HTTP verification
 * calls embedded in providerProvisioning.ts for Vapi, kept in a separate file
 * here since Bolna's provisioning flow is meaningfully simpler (Bolna's API
 * key is already account-scoped, so there is no cross-organization ownership
 * proof to do the way Vapi's platform key requires).
 *
 * GET/POST/PUT /v2/agent and POST /inbound/setup and POST /call are all
 * confirmed directly against Bolna's own published docs, including the full
 * OpenAPI schema for create/patch. See bolnaAgentBlueprint.ts for what's
 * still unconfirmed about the *contents* of the agent config itself.
 */

// Exported so providerReconciliationJob.ts can build its own bounded-read
// request to GET /executions/{id} (it needs raw Response access to enforce
// a response-size ceiling the way it already does for Vapi's /call/{id},
// rather than going through bolnaFetch()'s unbounded response.json()).
export const BOLNA_API_BASE = 'https://api.bolna.ai';
const REQUEST_TIMEOUT_MS = 10_000;

export class BolnaApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'BolnaApiError';
  }
}

export function platformBolnaApiKey(): string {
  if (process.env.PLATFORM_BOLNA_ENABLED !== 'true') {
    throw new Error('Platform-funded Bolna calling is not enabled');
  }
  const key = process.env.PLATFORM_BOLNA_API_KEY?.trim();
  if (!key) throw new Error('PLATFORM_BOLNA_API_KEY must be configured');
  return key;
}

async function bolnaFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${BOLNA_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${platformBolnaApiKey()}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BolnaApiError(
      error instanceof Error ? `Bolna request failed: ${error.message}` : 'Bolna request failed'
    );
  }
}

/**
 * Confirmed: GET /v2/agent/{agentId} (docs.bolna.ai/api-reference/agent/v2/get).
 */
export async function getBolnaAgent(agentId: string): Promise<Record<string, unknown>> {
  const response = await bolnaFetch(`/v2/agent/${encodeURIComponent(agentId)}`);
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new BolnaApiError('Bolna credentials were rejected', response.status);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new BolnaApiError('The Bolna agent was not found on this account', 404);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new BolnaApiError(`Bolna could not verify the agent (${response.status}): ${body.slice(0, 300)}`, response.status);
  }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    throw new BolnaApiError('Bolna returned an invalid agent payload');
  }
  return payload as Record<string, unknown>;
}

/** Confirmed: POST /v2/agent, full request schema from Bolna's own OpenAPI spec. */
export async function createBolnaAgent(body: Record<string, unknown>): Promise<{ agentId: string }> {
  const response = await bolnaFetch('/v2/agent', { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BolnaApiError(`Bolna agent creation failed (${response.status}): ${text.slice(0, 500)}`, response.status);
  }
  const payload = (await response.json()) as { agent_id?: unknown; id?: unknown };
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : typeof payload.id === 'string' ? payload.id : null;
  if (!agentId) throw new BolnaApiError('Bolna did not return an agent_id');
  return { agentId };
}

/**
 * Confirmed: PUT /v2/agent/{agentId} replaces the entire agent configuration
 * (tasks, toolchains, tools_config, prompts) — unlike PATCH, which only
 * updates a small allowlist of top-level agent_config fields (name, welcome
 * message, webhook_url, synthesizer, telephony_provider, calling_guardrails)
 * and silently ignores anything else, including tools_config/api_tools. This
 * product always needs to rewrite the full tool set, so PUT is used for
 * every update here; PATCH is not exposed by this client since nothing in
 * this codebase needs a small targeted edit that wouldn't also want the
 * tools rewritten.
 */
export async function updateBolnaAgent(agentId: string, body: Record<string, unknown>): Promise<void> {
  const response = await bolnaFetch(`/v2/agent/${encodeURIComponent(agentId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BolnaApiError(`Bolna agent update failed (${response.status}): ${text.slice(0, 500)}`, response.status);
  }
  await response.body?.cancel();
}

/**
 * Confirmed: POST /inbound/setup, {agent_id, phone_number_id}. This is what
 * actually makes Bolna route calls on this number to this agent — unlike
 * Vapi, there is no separate live per-call assistant-selection step, so this
 * binding is the entire routing decision.
 */
export async function setBolnaInboundAgent(input: { agentId: string; phoneNumberId: string }): Promise<void> {
  const response = await bolnaFetch('/inbound/setup', {
    method: 'POST',
    body: JSON.stringify({ agent_id: input.agentId, phone_number_id: input.phoneNumberId }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BolnaApiError(`Bolna inbound binding failed (${response.status}): ${text.slice(0, 500)}`, response.status);
  }
  await response.json().catch(() => null);
}

export interface BolnaOutboundCallInput {
  agentId: string;
  recipientPhoneNumber: string;
  fromPhoneNumber?: string;
  userData?: Record<string, string>;
}

/** Confirmed: POST /call, {agent_id, recipient_phone_number, ...}. */
export async function placeBolnaCall(input: BolnaOutboundCallInput): Promise<{ callId: string | null; status: string }> {
  const response = await bolnaFetch('/call', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: input.agentId,
      recipient_phone_number: input.recipientPhoneNumber,
      ...(input.fromPhoneNumber ? { from_phone_number: input.fromPhoneNumber } : {}),
      ...(input.userData ? { user_data: input.userData } : {}),
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BolnaApiError(`Bolna outbound call failed (${response.status}): ${text.slice(0, 500)}`, response.status);
  }
  const payload = (await response.json().catch(() => ({}))) as { id?: unknown; call_id?: unknown; status?: unknown };
  const callId = typeof payload.id === 'string' ? payload.id : typeof payload.call_id === 'string' ? payload.call_id : null;
  const status = typeof payload.status === 'string' ? payload.status : 'accepted';
  return { callId, status };
}
