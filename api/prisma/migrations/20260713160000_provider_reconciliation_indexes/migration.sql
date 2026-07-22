-- Provider reconciliation scans only stale communication attempts and uses
-- anti-joins to find missing usage/cost ledger rows. These indexes keep that
-- bounded worker bounded as the append-only ledgers grow.
CREATE INDEX "CommunicationAttempt_provider_channel_updatedAt_idx"
ON "CommunicationAttempt"("provider", "channel", "updatedAt");

CREATE INDEX "UsageEvent_attempt_metric_idx"
ON "UsageEvent"("communicationAttemptId", "metric");

CREATE INDEX "ProviderCostEntry_attempt_provider_costType_idx"
ON "ProviderCostEntry"("communicationAttemptId", "provider", "costType");
