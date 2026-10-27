# Queue Processing, Redis vs PostgreSQL, and Reliability (`docs/queue-processing.md`)

## 1. Authoritative Storage vs Transient Queue Storage

| Store | Role in CommHub | Never used for |
|---|---|---|
| **PostgreSQL** (`apps/api/prisma/schema.prisma`) | Permanent source of truth for contacts, suppressions, campaigns, approval history, per-recipient state (`CampaignRecipient`), webhook events (`ProviderEvent`), outbox (`OutboxEvent`), durable job records (`JobRecord`), usage costs (`UsageCost`), and audit logs (`AuditLog`). | — |
| **Redis** (`BullMQ`) | Transient background queue transport (`contact-import`, `campaign-processing`, `provider-submit-sms`, `provider-submit-voice`, `provider-status`, `report-generation`, `maintenance`). | Permanent record keeping, eligibility/suppression decisions, or proof of message delivery. |

### Why Redis is not used as a cache for eligibility
Suppression and campaign cancellation are safety-critical. A stale cached entry could allow a message to be sent to a citizen who just opted out. Therefore:
1. Dashboard summaries query PostgreSQL directly (fast indexed counts).
2. If optional non-sensitive dashboard caching is enabled in future, it must use a short TTL (e.g. 10–30s), be invalidated on campaign/import commits, and **must never be consulted by workers**.
3. Before every single provider submission, the worker calls `recheckRecipient()` in `packages/domain/src/db.ts` directly against PostgreSQL.

## 2. Transactional Outbox Pattern

To prevent losing work between a PostgreSQL commit and a Redis `queue.add()` call:
1. API endpoints write state changes and an `OutboxEvent` (`status = PENDING`) inside a single `prisma.$transaction(...)`.
2. The separate worker process (`apps/worker`) polls `OutboxEvent` rows and enqueues BullMQ jobs using a deterministic `jobId = outbox_<id>` (so duplicate publishes are deduplicated by BullMQ), then marks the row `PUBLISHED`.

## 3. Pre-Execution Safety Rechecks (`processRecipientSubmission`)

Immediately before every provider call, the worker verifies in order:
1. **Emergency Stop**: `SystemSetting[key="emergencyStop"]` is not active.
2. **Idempotency**: `CampaignRecipient.status` is still `PENDING` or `QUEUED`.
3. **Campaign State & Approval**: Campaign is `PROCESSING`/`SCHEDULED` and has a non-null `approverId` and `approvedAt`.
4. **Production Gate**: If `PROVIDER_MODE != MOCK`, provider approval, server-side API credentials, and all required compliance checklist items are verified.
5. **Operating Window**: Current time in the configured timezone is within permitted hours (`startHour..endHour`); otherwise the job is delayed via `job.moveToDelayed(...)`.
6. **Uncached Suppression & Preference Check**: Phone is not in `Suppression`, contact still exists, and `allowSms`/`allowVoice` is `true`. If ineligible, status becomes `SKIPPED_SUPPRESSED`.
7. **Atomic Claim**: `UPDATE CampaignRecipient SET status='SUBMITTING' WHERE id=? AND status IN ('PENDING','QUEUED')`.

## 4. Handling Uncertain Outcomes vs Safe Retries

- **`RETRYABLE`** (request definitely did not reach the provider, e.g. connection refused): status resets to `QUEUED` and `RetryableProviderError` is thrown so BullMQ retries with exponential backoff.
- **`UNCERTAIN`** (timeout or ambiguous response — the provider may or may not have accepted the request): status is recorded as `UNCERTAIN` and the job completes **without throwing**. It is **never blindly retried**. The maintenance reconciler polls `getCallStatus` / `getMessageStatus` or awaits a signed webhook callback.
- **Worker crash mid-flight**: rows stuck in `SUBMITTING` for >2 minutes are moved to `UNCERTAIN` by `reconcileOnce()`, never auto-resubmitted.
- **BullMQ completion ≠ delivery**: a job finishing only means the adapter call returned (typically `PROVIDER_ACCEPTED`). Final `COMPLETED` (voice playback finished) or `DELIVERED` (SMS receipt) is recorded only when reported by a verified provider webhook or status check.

## 5. Emergency Stop Limits

Activating the Emergency Stop immediately sets `emergencyStop.active = true` and pauses `SCHEDULED`/`PROCESSING` campaigns in one DB transaction. Active workers check this flag before every new provider request. **Limitation:** requests that have already been transmitted to an external telecom provider before the stop was activated cannot be recalled by this software.
