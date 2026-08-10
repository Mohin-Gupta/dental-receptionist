/**
 * Thin client for Vobiz's telephony REST API, used directly by our backend to
 * drive the human-handoff transfer for Bolna-routed calls — bypassing
 * Bolna's own built-in Transfer Call tool entirely, because that tool has a
 * single static destination number configured at agent-setup time and
 * cannot be pointed at a different number per call (see the architecture
 * notes in bolna.webhook.ts's transferToHuman handler).
 *
 * Confirmed directly against Vobiz's own docs (docs.vobiz.ai/call/transfer-call):
 * POST /Account/{authId}/Call/{callUuid}/ with a body of
 * { legs: 'aleg'|'bleg'|'both', aleg_url, aleg_method, bleg_url, bleg_method }.
 * A 404 response means the call_uuid is not currently an in-progress call.
 */

const VOBIZ_API_BASE = 'https://api.vobiz.ai/api/v1';
const REQUEST_TIMEOUT_MS = 8_000;

export class VobizApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'VobizApiError';
  }
}

function platformVobizCredentials(): { authId: string; authToken: string } {
  if (process.env.PLATFORM_VOBIZ_ENABLED !== 'true') {
    throw new Error('Platform-funded Vobiz calling is not enabled');
  }
  const authId = process.env.PLATFORM_VOBIZ_AUTH_ID?.trim();
  const authToken = process.env.PLATFORM_VOBIZ_AUTH_TOKEN?.trim();
  if (!authId || !authToken) {
    throw new Error('PLATFORM_VOBIZ_AUTH_ID and PLATFORM_VOBIZ_AUTH_TOKEN must be configured');
  }
  return { authId, authToken };
}

export type VobizCallLeg = 'aleg' | 'bleg' | 'both';

/**
 * Redirects the caller's leg (A-leg) of an in-progress call to a new URL that
 * returns XML instructions — confirmed shape, per Vobiz's own docs. We only
 * ever need the A-leg case (the caller is redirected to dial the clinic's
 * human handoff number); bleg/both aren't used by this product but the
 * fields exist on Vobiz's API if ever needed.
 *
 * Confirmed by a live test call: `callUuid` here — passed as Bolna's
 * auto-injected `call_sid` system variable — is the same identifier as the
 * Vobiz call_uuid for calls routed through Vobiz as Bolna's telephony
 * provider. If that ever changes on Bolna/Vobiz's side, Vobiz would return
 * 404 ("call_uuid is not an active call") and this throws; the caller
 * (bolna.webhook.ts) fails closed with an apology rather than a crash.
 */
export async function transferVobizCall(input: {
  callUuid: string;
  destinationUrl: string;
  method?: 'GET' | 'POST';
}): Promise<{ apiId: string | null }> {
  const { authId, authToken } = platformVobizCredentials();
  const endpoint = `${VOBIZ_API_BASE}/Account/${encodeURIComponent(authId)}/Call/${encodeURIComponent(input.callUuid)}/`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-ID': authId,
        'X-Auth-Token': authToken,
      },
      body: JSON.stringify({
        legs: 'aleg',
        aleg_url: input.destinationUrl,
        aleg_method: input.method ?? 'POST',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new VobizApiError(
      error instanceof Error ? `Vobiz transfer request failed: ${error.message}` : 'Vobiz transfer request failed'
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new VobizApiError(
      `Vobiz rejected the transfer request (${response.status}): ${body.slice(0, 300)}`,
      response.status
    );
  }

  const payload = (await response.json().catch(() => null)) as { api_id?: unknown } | null;
  return { apiId: typeof payload?.api_id === 'string' ? payload.api_id : null };
}

/**
 * Renders the XML instruction Vobiz fetches from the transfer's
 * `destinationUrl`: a Dial to the clinic's human handoff number. Per Vobiz's
 * own transfer docs, `callerId` on an outbound Dial should be a Vobiz number
 * owned by this account, or the new outbound leg may fail as unauthorized —
 * pass the clinic's own dialled Vobiz number (to_number) here, since that is
 * guaranteed to be one we own.
 */
export function vobizDialInstructionXml(destinationE164: string, callerIdE164: string): string {
  const destination = destinationE164.replace(/[^0-9+]/g, '');
  const callerId = callerIdE164.replace(/[^0-9+]/g, '');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${callerId}"><Number>${destination}</Number></Dial></Response>`;
}

export function vobizHangupInstructionXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
}
