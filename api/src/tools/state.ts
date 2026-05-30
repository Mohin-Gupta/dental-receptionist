// In-memory state per call — cleared on call end
export const slotCache: Record<string, {
  date: string;
  slots: { start: string; label: string }[];
}> = {};

export const confirmedDetails: Record<string, {
  patientName: string;
  patientPhone: string;
  date: string;
  time: string;
  reason: string;
}> = {};

export const nameCache: Record<string, string> = {};

export function clearCallState(callId: string) {
  delete slotCache[callId];
  delete confirmedDetails[callId];
  delete nameCache[callId];
}