# Production deployment and operations

This service is deployed as four routine workloads/jobs from the API source tree:

- **API:** the default `runtime` image command, `node dist/index.js`. It may be horizontally scaled.
- **Worker:** the same `runtime` image with command `node dist/worker.js`. It runs reminders, the transactional outbox, token cleanup, billing-grace expiry, Stripe usage export, and bounded sensitive-payload retention.
- **Migration job:** the Docker `migration` target, run once per release before the new API and worker version.
- **Price-catalog sync job:** the runtime image with command `npm run billing:sync-prices`, run after migrations and before the worker/API.

The first encryption-aware release also runs the one-time legacy-secret job
described in section 6; it is not a recurring workload.

The customer dashboard is built separately from `web/Dockerfile`. Its
`NEXT_PUBLIC_*` values are embedded at build time; they are not runtime secrets,
and changing them requires a new web image.

Use managed PostgreSQL with point-in-time recovery and managed Redis with TLS, authentication, persistence, replicas, and a `noeviction` policy. PostgreSQL is authoritative; Redis contains queues, OAuth nonces, and live call state, so Redis loss is still operationally significant.

## 1. Production prerequisites

1. Create separate production and staging projects/accounts for PostgreSQL, Redis, Stripe, Vapi, Twilio, Google OAuth, and SMTP. Do not share signing secrets or provider resources between environments.
2. Put every value from [`.env.example`](./.env.example) in a managed secret/config store. Restrict production secrets to the API, worker, and migration identities that need them. Do not commit or bake `.env` files into images.
3. Use TLS for the public application, PostgreSQL, Redis, SMTP, and provider traffic. `WEB_ORIGIN`, `PUBLIC_API_URL`, billing return URLs, and the Google callback must be HTTPS in production.
4. Generate independent high-entropy values for the data-encryption key, OAuth-state secret, Vapi HMAC secret, operations bearer token, database password, and Redis password. Do not reuse provider secrets. Generate the operations token with `openssl rand -base64 48` and give it only to the API and monitoring/operator system; the worker does not need it.
5. Configure the production domain and proxy to preserve the original scheme, host, path, request body, and provider signature headers. Strip authorization, cookies, request bodies, OAuth query strings, patient data, and webhook payloads from proxy/APM logs.
6. Complete the applicable DPA/BAA, privacy notice, terms, data-residency review, breach process, and subprocessors list before handling patient data. `VAPI_STORE_TRANSCRIPTS`, `GOOGLE_CALENDAR_STORE_PHI`, and `GOOGLE_WORKSPACE_BAA_CONFIRMED` default to `false` deliberately.

`validateRuntimeConfiguration()` runs before either long-lived process starts. In production it rejects missing database/Redis, public origins, encryption, OAuth-state, Vapi-HMAC, Google OAuth, SMTP, legal-document versions, pinned Stripe configuration, webhook signing secrets, heartbeat policy, and explicit sensitive-payload retention periods; the API additionally requires the operations bearer token. It also validates the exact trusted-proxy hop count, webhook request ceiling, JSON/urlencoded byte limits, and an explicitly configured Vapi webhook URL before Express accepts traffic. Keep those byte limits aligned with the ingress proxy and set `TRUST_PROXY_HOPS` to the actual topology; an excessive value can make client-IP controls trust spoofed forwarding headers.

## 2. Build immutable images

Use the lockfile and an approved digest-pinned Node 24 image:

```sh
docker build \
  --build-arg NODE_IMAGE='node:24.16.0-bookworm-slim@sha256:<approved-digest>' \
  --target runtime \
  -t registry.example.com/dental-api:<git-sha> \
  api

docker build \
  --build-arg NODE_IMAGE='node:24.16.0-bookworm-slim@sha256:<same-approved-digest>' \
  --target migration \
  -t registry.example.com/dental-api-migration:<git-sha> \
  api

docker build \
  --build-arg NODE_IMAGE='node:24.16.0-bookworm-slim@sha256:<same-approved-digest>' \
  --build-arg NEXT_PUBLIC_API_URL='https://api.example.com/api' \
  --build-arg NEXT_PUBLIC_BILLING_PLAN_KEYS='starter' \
  --build-arg NEXT_PUBLIC_TERMS_URL='https://example.com/terms' \
  --build-arg NEXT_PUBLIC_PRIVACY_URL='https://example.com/privacy' \
  -t registry.example.com/dental-web:<git-sha> \
  web
```

The runtime image contains production dependencies only and runs as the unprivileged `node` user. Scan the image and dependency lockfile in CI, sign the image, deploy by digest, and retain the previous known-good image. The Dockerfile intentionally has no image-level `HEALTHCHECK`, because the same runtime image also runs a worker with no HTTP listener; configure per-workload probes instead.

## 3. Release and migration sequence

For every release:

1. Build, test, scan, and deploy the exact candidate to staging.
2. Take a fresh PostgreSQL backup and record the current migration/image versions. Restore that backup into an isolated staging database and run the migration there first.
3. Run the migration image once with only the production `DATABASE_URL` and required network trust:

   ```sh
   docker run --rm \
     -e DATABASE_URL='<injected-by-secret-manager>' \
     registry.example.com/dental-api-migration:<git-sha>
   ```

4. Require a zero exit code from `prisma migrate deploy`. The multi-tenant foundation migration includes integrity preflight checks and may stop on ambiguous legacy data; fix the data deliberately and rerun it. Never use `prisma migrate dev`, `db push`, or an automatic destructive rollback in production.
5. With `DATABASE_URL`, `STRIPE_PLAN_CONFIG_JSON`, and `BILLING_PRICE_VERSIONS_JSON` injected, run `npm run billing:sync-prices` as a one-shot job from the same release image. It creates only missing immutable local rate versions and fails on drift, gaps, missing current metered metrics, or missing operational-tenant currency coverage. There is intentionally no tenant-facing API for changing retail rates.
6. Deploy the worker with `node dist/worker.js`, wait for its database heartbeat, then deploy the API. Use a termination grace period of at least 30 seconds and wait for old instances to drain. The API and worker must use the same `WORKER_HEARTBEAT_NAME` and freshness settings.
7. On the first encryption-aware release, run the legacy-secret dry-run/apply/verification sequence in section 6 only after every old API and worker replica has drained.
8. Verify readiness, authentication, tenant switching, provider integration health, one test appointment, one test reminder in a non-patient test tenant, Stripe Checkout/Portal, and all webhook deliveries.

Schema changes should remain backward-compatible across a rolling release. If a release fails after a migration, roll application containers forward or back only when the old version is schema-compatible. Database restore is the last-resort rollback and must follow the restore procedure below.

## 4. Health, scaling, and alerts

- `GET /health` and `GET /health/live` are process liveness checks and do not call dependencies.
- `GET /health/ready` checks PostgreSQL and Redis. When `REQUIRE_WORKER_HEARTBEAT_FOR_READINESS=true`, it also requires the row named by `WORKER_HEARTBEAT_NAME` to be newer than `WORKER_HEARTBEAT_MAX_AGE_SECONDS`; otherwise it returns `503`. Use it for readiness, not liveness. Production requires an explicit true/false choice so a missing value cannot silently change the gate.
- The worker writes its first heartbeat before starting queues and refreshes it every `WORKER_HEARTBEAT_INTERVAL_SECONDS`. Set the maximum age to at least twice that interval. The worker still has no HTTP listener, so also supervise its process and alert on restarts.
- `GET /api/ops/status` requires `Authorization: Bearer <OPERATIONS_BEARER_TOKEN>`. It returns only global operational timestamps and counts: worker/process and per-recurring-task freshness, dead-letter outbox and budget-alert rows, active budget-evaluation configuration issues, unfinalized terminal usage, usage approaching Stripe's export window, quarantined provider webhooks/usage exports, and processing leases stale for five minutes. It never returns tenant identifiers or payloads. A `200` response with `status: attention_required` is reachable but unhealthy work, while `503` means status could not be read.
- Start with one worker replica. Scale only after confirming the recurring maintenance tasks and provider rate limits behave correctly at the intended concurrency. API replicas are stateless apart from PostgreSQL/Redis and can scale independently.
- Alert on database/Redis saturation, connection exhaustion, HTTP 5xx/latency, webhook non-2xx responses, billing-account suspension, Stripe meter export lag, SMTP failures, and provider spend anomalies per organization.

Do not expose health endpoints through an authenticated CDN cache. Allow readiness probes only from the deployment network where possible. Keep `/api/ops/status` private to the monitoring/operator network, redact its Authorization header at every proxy/APM layer, rotate its token through the secret manager, and alert on repeated `401` responses. The bearer token is defense in depth, not a substitute for network policy.

## 5. Provider and billing configuration

### Stripe

Create recurring base Prices and, for each billable metric, a Stripe Meter plus metered recurring Price. Put their immutable IDs and event names in `STRIPE_PLAN_CONFIG_JSON`; plan keys are public application identifiers, not Stripe lookup keys. Separately configure `BILLING_PRICE_VERSIONS_JSON` and materialize it with `npm run billing:sync-prices`; Stripe Price IDs do not populate local rates automatically. `unitAmountMinor` is a positive integer minor-unit string, `unitQuantity` is a positive decimal string, currency is an uppercase three-letter code, and each plan/metric/currency timeline must have an open-ended latest version. An explicit previous `effectiveTo` must equal its successor's `effectiveFrom`; an older null end is implicitly superseded. Every Stripe metered plan metric needs a currently effective local version, and every currency used by an operational tenant needs coverage. Quantity budgets work without local prices, but amount-based budgets and locally rated totals do not. Confirm currency, billing interval, tax behavior, trials, grace period, refunds, entitlement behavior, and local rate versions in staging.

Budget revisions are append-only and exact no-op saves return the current policy. Soft values are the warning basis for percentage alerts; hard values are the provider-dispatch ceiling (with the configured enforcement mode). Only `voice_seconds` and `sms_segments` can be conservatively reserved before provider dispatch and therefore support blocking. Vapi token and text-to-speech metrics are post-consumption and intentionally support alerts only; do not sell them as a hard cap. Billing-period budgets follow the current Stripe subscription mirror. Daily and calendar-month policies use UTC boundaries; the dashboard labels them explicitly. Monetary policies must match the organization's configured billing currency, and all limits must be positive.

The application currently emits and accepts catalog/budget configuration for
exactly these usage metrics:

- `voice_seconds` and `sms_segments`
- `vapi_llm_prompt_tokens`, `vapi_llm_cached_prompt_tokens`, and `vapi_llm_completion_tokens`
- `vapi_tts_characters`

The example environment catalog includes all six so provider-derived usage does
not become unrated or remain quarantined during Stripe export. Enabling
`communications.voice` requires voice seconds plus all four Vapi model/speech
metrics, and enabling `communications.sms` requires SMS segments. The exporter
treats emitted-but-unconfigured usage as a non-retryable configuration error;
do not use omission to model a base-fee allowance. Email delivery, recording
storage, CPU time, and generic server load are not currently measured by
durable usage emitters and must not be sold as usage-metered dimensions until
their attribution and reconciliation paths exist. The sample local rate amounts
demonstrate configuration syntax only; replace them with approved retail rates
before catalog sync.

Every sellable plan must explicitly grant the runtime feature keys it includes:
`appointments.write`, `communications.voice`, and `communications.sms`. Set
`clinics.max` to the numeric clinic limit. `NEXT_PUBLIC_BILLING_PLAN_KEYS` must
contain the same public plan keys exposed for Checkout.

Register `POST https://api.example.com/api/webhooks/stripe` and subscribe to:

- `checkout.session.completed` and `checkout.session.async_payment_succeeded`
- `checkout.session.expired` and `checkout.session.async_payment_failed`
- `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, and `.resumed`
- `invoice.paid`, `.payment_failed`, `.payment_action_required`, and `.finalization_failed`

Store the endpoint signing secret in `STRIPE_WEBHOOK_SECRET`. During signing-secret rotation, deploy the new and old values together using `STRIPE_WEBHOOK_SECRETS`, confirm new deliveries, then remove the old value. Keep `STRIPE_EXPECT_LIVEMODE=true` in production. Do not set `STRIPE_API_BASE_URL` in production.

Checkout creation is serialized per organization in PostgreSQL and a hosted URL is encrypted at rest. Set `STRIPE_CHECKOUT_TTL_MINUTES` between 35 and 1435. Also enable Stripe Checkout's customer-level **limit customers to one subscription** control as defense in depth against sessions created outside this application. A conflicting second provider subscription is quarantined locally; it must be investigated and refunded/canceled in Stripe rather than allowed to replace tenant entitlements.

The worker verifies/materializes the configured local price catalog before starting queues, exports pending usage every 30 seconds when `BILLING_MAINTENANCE_ENABLED` is not `false`, and reconciles stale Twilio/Vapi attempts every five minutes using provider reads only. Reconcile the local usage ledger, Stripe meter events, invoices, credits/refunds, and provider cost reports before charging the first customer. Configure Stripe retries and alert on the local webhook inbox/dead-letter state; webhook responses, not dashboard clicks, are the subscription source of truth.

### Vapi

Set `VAPI_WEBHOOK_URL=https://api.example.com/api/webhook/vapi` and configure Vapi to call that exact URL with `POST`. Platform provisioning can derive it from `PUBLIC_API_URL` when omitted, but an explicit value is easier to review and production startup rejects a configured non-HTTPS value. The verifier expects:

- timestamp header `x-vapi-timestamp` (or `VAPI_HMAC_TIMESTAMP_HEADER`),
- HMAC header `x-vapi-signature` (or `VAPI_HMAC_SIGNATURE_HEADER`), and
- an HMAC-SHA256 over `<timestamp>.<exact raw request body>`, supplied as hexadecimal or Base64, optionally prefixed with `sha256=`.

Use the same secret as `VAPI_HMAC_SECRET` and keep the replay window short. Test signing through the real proxy before launch; body reserialization breaks the signature. The bearer secret is a non-production migration fallback only.

Production voice traffic currently uses the platform-funded operator flow. Tenant-owned Vapi credentials may be staged through the integrations UI/API, but their resources cannot be activated in production until per-tenant webhook credentials are provisioned and verified; this prevents one tenant-held webhook secret from authenticating callbacks attributed to another tenant. Use `platform-vapi:provision` to bind production resources.

For every inbound phone number, remove the fixed `assistantId` and `squadId`, configure the phone-number Server URL as `VAPI_WEBHOOK_URL`, and attach the operator-controlled Vapi Custom Credential. The phone, assistant, and any tool-level server override must use the same URL and credential ID. Map that phone resource to one active receptionist assistant in the same account and clinic scope. Vapi then sends an authenticated `assistant-request`; the API resolves the tenant and reserves the maximum voice duration against subscription and budget controls before it returns the assistant ID. A denied request returns a speakable error and never starts the configured AI assistant. Keep this admission path highly available and low latency because Vapi applies a fixed response deadline.

For platform-funded voice, set `PLATFORM_VAPI_ENABLED=true` and inject `PLATFORM_VAPI_API_KEY` from the deployment secret manager into both API and worker workloads. Never put that key in a tenant row or browser-visible variable. Bind a verified phone number and assistant with the operator-only command below; tenant endpoints cannot create, alter, deactivate, or rotate a platform-managed mapping. Globally unique provider resource IDs and the clinic-bound phone mapping remain the source of tenant attribution even though the provider balance is shared.

```bash
npm run vapi:bind-platform -- --organization-id ORG_UUID --clinic-id CLINIC_UUID --phone-number-id VAPI_PHONE_ID --assistant-id VAPI_ASSISTANT_ID --assistant-scope organization --activate --confirm
```

The command verifies both resources through the platform key, requires them to report the same Vapi organization, verifies the dynamic phone-number admission Server URL and Custom Credential, requires the assistant's `maxDurationSeconds` to match `VAPI_MAX_INBOUND_CALL_SECONDS`, enforces the configured per-organization resource caps, writes an operator audit event, and is safe to rerun with the same assignment. Omit `--activate` to stage provisioning rows. It refuses to replace a tenant-owned Vapi account or move an active resource between clinics. Manual removal or reassignment should first stop new calls and drain/reconcile in-flight attempts; signed terminal reports continue using immutable historical attempt attribution after local deactivation.

Do not enable legacy global provider variables. Encrypted transcript extraction into `CallLog` additionally requires `VAPI_STORE_TRANSCRIPTS=true` and an explicit `message.compliance.recordingConsent.grantedAt` value on the webhook. The durable Vapi inbox stores an encrypted structural envelope (event/call/resource identifiers, tool names/IDs, byte count, and body hash), not tool arguments, customer numbers, transcripts, summaries, recordings, or the raw request. Recording/transcription disclosure and consent remain legal and product obligations; a field in a webhook is not proof that the consent flow is adequate.

Set `VAPI_MAX_OUTBOUND_CALL_SECONDS` as the outbound call and pre-authorization ceiling. Set `VAPI_MAX_INBOUND_CALL_SECONDS` to exactly the `maxDurationSeconds` configured on every active Vapi assistant; otherwise the reserved budget can differ from the provider-enforced maximum. Both values accept 60–7200 seconds. Provider limits are defense in depth: subscription entitlements, tenant budgets, and usage reconciliation still control billable access in the application.

### Twilio

Outbound messages set their status callback to `POST https://api.example.com/api/webhook/twilio/message-status`. Configure each Messaging Service/number inbound webhook as `POST https://api.example.com/api/webhook/twilio/inbound`, enable Advanced Opt-Out, and ensure it forwards `OptOutType`. The application stores organization-wide HMAC-addressed STOP/START preferences and checks them before dispatch; Twilio's own block list remains the final race-safe enforcement layer. Post-visit feedback requires a recorded START/opt-in, while appointment notices block known opt-outs.

`PUBLIC_API_URL` must be the exact external origin with no path, query, credentials, or fragment. Twilio validates each final callback URL and all form fields, so do not rewrite them at the proxy. Ensure the `X-Twilio-Signature` header reaches the API. Do not configure an application reply for Advanced Opt-Out events because Twilio has already sent the confirmation.

Create organization-owned Twilio provider accounts and phone-number or Messaging Service resources through the integrations UI/API. Keep account auth tokens encrypted and tenant-scoped; do not use global production credentials. Configure geo-permissions, spend/usage triggers, sender registration, opt-out handling, and regional messaging requirements before sending to customers.

### Google Calendar and SMTP

Register `https://api.example.com/api/auth/google/callback` exactly in the Google OAuth client. OAuth connections are organization/clinic scoped and tokens are encrypted. Keep calendar event content non-PHI unless both calendar PHI flags are intentionally enabled and the relevant contract, access, retention, and deletion controls are verified.

Verify SMTP SPF, DKIM, DMARC, bounce handling, and a monitored reply/abuse path. Test invite, verification, and password-reset delivery without logging addresses or tokens.

Budget-alert deliveries are durable per recipient and protected by worker leases, but SMTP has no end-to-end idempotency key. A worker crash after the SMTP server accepts a message and before the database acknowledgement can therefore produce a duplicate on retry. Either accept that at-least-once behavior and make the message harmless when repeated, or replace SMTP for alerts with a transactional provider that supports application-supplied idempotency keys.

## 6. Encryption and secret rotation

`DATA_ENCRYPTION_KEYS` is a JSON keyring of Base64-encoded 32-byte AES keys. Encrypted values record their key ID; all API and worker replicas must receive the same keyring.

### One-time legacy plaintext migration

The application can read legacy plaintext Google tokens and TOTP seeds during a
rolling upgrade, but they must not remain plaintext in production. After every
API and worker replica is running an encryption-aware release with the same
`DATA_ENCRYPTION_KEYS` and `DATA_ENCRYPTION_ACTIVE_KEY_ID`, run this one-shot
job from that exact runtime image:

```sh
# Read-only inventory; this is also the default when no flag is supplied.
npm run security:encrypt-legacy-secrets -- --dry-run

# Compare-and-set each value so a concurrent OAuth refresh or MFA setup wins.
npm run security:encrypt-legacy-secrets -- --apply

# Must report plaintextFound: 0 for all three groups.
npm run security:encrypt-legacy-secrets -- --dry-run
```

Run the job with only `DATABASE_URL`, `DATA_ENCRYPTION_KEYS`, and
`DATA_ENCRYPTION_ACTIVE_KEY_ID` injected, after a fresh database backup. It
encrypts legacy `Clinic.googleTokens`, `CalendarConnection.googleTokens`, and
`MfaMethod.secret` values in bounded batches. It never prints secret material,
skips existing `enc:v1` ciphertext, is safe to rerun, and exits non-zero rather
than guessing an encryption purpose when a calendar connection has no clinic or
doctor owner or an unknown MFA method contains a secret. Fix any reported
purpose problem and rerun. Do not run it from an older image that cannot
decrypt `enc:v1` values.

This command migrates plaintext only. It does not re-encrypt existing
ciphertext under a new key ID.

To rotate a data key safely:

1. Add a new key ID while retaining every old key, but leave the old active ID selected. Deploy the keyring everywhere and verify readiness.
2. Change `DATA_ENCRYPTION_ACTIVE_KEY_ID` to the new ID and deploy API and worker together. New/updated provider credentials, Google tokens, MFA secrets, webhook payloads, and transcripts now use the new key.
3. Run a controlled, audited key-rotation re-encryption job for every encrypted column and verify no retained ciphertext references the old key ID. The plaintext migration command above is not a key-rotation job; the repository does **not** currently include this bulk rewrite job.
4. Back up and restore-test the new key material, then remove the old key from all replicas. Never remove an old key while retained database rows still reference it.

Rotate `OAUTH_STATE_SECRET` during a low-traffic window; outstanding ten-minute OAuth states become invalid because this secret has no overlap keyring. Rotate Stripe with the overlapping-secret flow above. Vapi currently accepts one HMAC secret, so coordinate its change and deployment closely. Rotate database, Redis, SMTP, Google, Twilio, and Vapi credentials through their providers, update the secret manager, restart both workloads, confirm health/delivery, and revoke the old value. Record each rotation without recording secret material.

The communication-preference HMAC keyring also supports overlap. Add a new Base64 key to every replica first, then switch `COMMUNICATION_PREFERENCE_HMAC_ACTIVE_KEY_ID` everywhere in one deployment. Reads check all retained key IDs and later STOP/START writes migrate that address to the active hash. Do not remove an old HMAC key until an audited backfill has migrated every stored preference; otherwise old opt-outs become undiscoverable.

## 7. Backups and restore

- Enable encrypted PostgreSQL point-in-time recovery plus independent scheduled snapshots. Set retention from the approved legal/business policy; do not equate backup retention with application-record retention.
- Enable Redis persistence and provider-managed backups where available. Redis restoration may replay or lose scheduled work, so reconcile reminder jobs, the outbox, OAuth sessions, call state, and billing export state afterward.
- Back up encryption keys separately in a restricted recovery vault. A database backup without every referenced encryption key is not recoverable.
- Run an isolated restore drill at least quarterly and before major schema changes. Verify migration status, tenant counts, representative tenant-scoped reads, encrypted-field decryption, provider connections without sending live traffic, usage totals, and audit-log continuity. Record recovery time and recovery point achieved.

Incident restore sequence:

1. Stop or fence writes and provider callbacks; capture the incident time and suspected corruption window.
2. Restore PostgreSQL to an isolated network at the chosen point and restore the matching keyring. Validate it before changing any production endpoint.
3. Restore Redis to a compatible point when safe, or start empty and deliberately reconstruct/reconcile queues from durable PostgreSQL state. Do not blindly replay outbound communications.
4. Run `prisma migrate deploy`, deploy the matching application image, run tenant-isolation and billing reconciliation checks, then reopen traffic gradually.
5. Rotate credentials if compromise is possible, notify affected parties under the incident plan, and preserve audit evidence.

## 8. Retention and production go-live gate

The worker enforces explicit, bounded-batch retention for completed provider webhook envelopes, terminal communication request/response payloads and phone endpoints, call transcripts, and terminal outbox rows. Production will not start without all four periods in `.env.example`. These controls intentionally preserve tenant attribution plus immutable usage/cost records.

This is not a complete legal retention/erasure product. Before processing production PHI, approve a per-record matrix for patients, appointments, call-log metadata, audit/security records, usage/cost/tax evidence, provider systems, and backups. Add tenant offboarding, access/export/deletion requests, legal holds, purge audit evidence, and backup-expiry treatment. The configured payload periods must follow that approved policy, not convenient defaults.

Final go-live checklist:

- [ ] Production restore drill passes and encryption keys are recoverable.
- [ ] Migration preflight passes on a restored production-shaped database.
- [ ] API liveness/readiness and worker/queue alerts are active and tested.
- [ ] Tenant-isolation authorization tests cover every role, clinic switch, object lookup, export, webhook, provider resource, and billing endpoint.
- [ ] Stripe test clocks and live-mode smoke tests reconcile usage through invoice totals; spend caps and anomaly alerts are set.
- [ ] Vapi and Twilio signatures pass through the production proxy; replay, duplicate, invalid-signature, and out-of-order webhook tests pass.
- [ ] Twilio is tenant-owned and every production Vapi resource is operator-bound platform Vapi; globally unique resources resolve to the expected tenant/clinic, both workloads have the same platform key when enabled, and legacy provider fallback is disabled.
- [ ] SMTP authentication and all account lifecycle emails work.
- [ ] Consent, recording, transcript, calendar-PHI, privacy, terms, retention, deletion, BAA/DPA, and incident-response reviews are signed off.
- [ ] Logs, traces, metrics, support tooling, and backups do not expose secrets or unnecessary patient data.
- [ ] Rate limits, database/Redis capacity, provider quotas, graceful shutdown, rollback compatibility, and an on-call runbook are load-tested.
- [ ] A non-patient canary tenant completes registration, subscription, appointment, reminder, cancellation, invoice, and tenant offboarding end to end.
