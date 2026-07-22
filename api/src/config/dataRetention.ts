function retentionDays(name: string, developmentDefault: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`${name} is required in production`);
    }
    return developmentDefault;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 3_650) {
    throw new Error(`${name} must be an integer between 0 and 3650`);
  }
  return value;
}

export function getDataRetentionConfig() {
  return {
    providerWebhookDays: retentionDays('PROVIDER_WEBHOOK_PAYLOAD_RETENTION_DAYS', 30),
    communicationPayloadDays: retentionDays('COMMUNICATION_PAYLOAD_RETENTION_DAYS', 30),
    transcriptDays: retentionDays('CALL_TRANSCRIPT_RETENTION_DAYS', 0),
    outboxDays: retentionDays('OUTBOX_TERMINAL_RETENTION_DAYS', 30),
    registrationRequestDays: retentionDays('REGISTRATION_REQUEST_RETENTION_DAYS', 30),
  };
}
