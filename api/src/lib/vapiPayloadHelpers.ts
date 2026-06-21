/**
 * vapiPayloadHelpers.ts — pure functions for extracting data out of Vapi's
 * webhook payloads. Split out of vapi.webhook.ts so the router file only
 * contains routing/orchestration logic, not payload-shape parsing details.
 */

export function extractDurationSecs(message: any): number | null {
  const call = message.call;

  if (typeof message.durationSeconds === 'number') {
    return Math.round(message.durationSeconds);
  }
  if (typeof message.durationMs === 'number') {
    return Math.round(message.durationMs / 1000);
  }
  if (typeof call?.duration === 'number' && call.duration > 0) {
    return call.duration > 10000 ? Math.round(call.duration / 1000) : Math.round(call.duration);
  }

  const startedAt = call?.startedAt ?? message.startedAt;
  const endedAt   = call?.endedAt ?? message.endedAt;

  if (startedAt && endedAt) {
    const diffMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (diffMs > 0) return Math.round(diffMs / 1000);
  }

  console.warn('Could not extract call duration from any known field. Payload keys:', Object.keys(message));
  return null;
}

export function extractDirectionAndPhone(message: any): { direction: 'inbound' | 'outbound'; phoneNumber: string | null } {
  const call = message.call;

  const direction: 'inbound' | 'outbound' =
    call?.type === 'outboundPhoneCall' ? 'outbound' : 'inbound';

  const rawNumber =
    call?.customer?.number ??
    call?.customer?.phoneNumber ??
    message.customer?.number ??
    message.customer?.phoneNumber ??
    call?.phoneNumber ??
    null;

  if (!rawNumber) {
    console.warn('Could not extract phone number from call payload. call.customer:', JSON.stringify(call?.customer));
    return { direction, phoneNumber: null };
  }

  return { direction, phoneNumber: rawNumber };
}