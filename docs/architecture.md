# Architecture and Implementation Plan (Stage 1)

Internal tool for authorised political / public-service communications. It is not a SaaS product: there are no plans, pricing, wallets or resellers.
**Default mode is MOCK. No real recipient is ever contacted until a provider is approved, configured and the compliance checklist is complete.**

## Monorepo layout
```
apps/api      NestJS REST API + Swagger, Prisma, auth/RBAC, webhooks, outbox publisher
apps/worker   Separate Node process: BullMQ workers (graceful shutdown)
apps/web      React + Vite + TS + Tailwind + React Router + TanStack Query + Recharts
packages/shared-types       DTO/enums/status model shared by all apps
packages/provider-adapters  VoiceProvider, SmsProvider interfaces + Mock providers
packages/configuration      Env schema validation (zod), feature/mode flags
infra/docker-compose.yml    PostgreSQL + Redis (local dev)
docs/                       architecture, setup, api, deployment, security, queue-processing
```

## Key design decisions
| Concern | Decision |
|---|---|
| Source of truth | PostgreSQL (contacts, campaigns, approvals, audit, provider refs, outcomes, suppression, job records). |
| Redis | (a) BullMQ storage only (b) optional short-TTL cache of non-sensitive dashboard counts. Never used for eligibility/suppression/cancellation decisions. |
| Queue reliability | Transactional outbox: the API writes `OutboxEvent` in the same DB transaction as the state change; a publisher enqueues to BullMQ and marks it published. Reconciler re-enqueues stale events. |
| Execution safety | Per-recipient `CampaignRecipient` row with state machine. Before every provider call the worker rechecks: emergency stop, campaign status/approval, cancellation, contact suppression, operating window, provider approval. |
| Uncertain outcomes | Timeout / ambiguous response => state `UNCERTAIN`; never blindly resubmitted. Reconciled via `getStatus` or webhook; resubmit only via explicit operator action. Idempotency key sent where the provider supports it. |
| Webhooks | Signature verified via adapter `verifyWebhook()`; payload validated; stored in `ProviderEvent` with unique `(provider, eventId)`; out-of-order handled with a status rank (never regress a terminal status). |
| Status model | `SUBMITTED -> PROVIDER_ACCEPTED -> ANSWERED -> COMPLETED` (voice), `SUBMITTED -> ACCEPTED -> DELIVERED` (SMS), plus `FAILED`, `UNCERTAIN`, `SUPPRESSED_SKIPPED`, `CANCELLED`. "Answered" never means "heard". |
| Auth | argon2 password hash, short-lived JWT access + rotating refresh in httpOnly cookie, login rate limiting, optional TOTP MFA, server-side permission guard on every route. |
| RBAC | Roles: ADMIN, OPERATOR, APPROVER, AUDITOR. Guard checks permissions; role changes admin-only; maker-checker (creator cannot approve own campaign). |
| Time | UTC in DB; org timezone shown in UI. |
| Storage | `StorageAdapter` with local-disk (dev) and S3-compatible implementations; private, signed access via API. |
| Secrets | Provider credentials only via server env / secret manager; UI shows configured/not-configured. |

## Staged plan
1. **Foundation**: monorepo, config, Prisma schema, auth/RBAC, dashboard shell. 
2. **Contacts + approvals**: CSV import (preview/validate/dedupe), suppression, campaign lifecycle.
3. **Queues**: BullMQ, worker, outbox, scheduler, retries, pause/cancel, emergency stop.
4. **Providers**: adapters, mocks, webhooks and simulator.
5. **Reports / audit / usage cost / security hardening**.
6. **Docs, CI, tests** (tests written alongside each stage).

## Known external requirements (not verifiable by this software)
Verify TRAI/DLT registration, election-commission and privacy rules, and each provider's explicit written approval for political use before any production adapter is added. No real provider adapter is implemented; endpoints are not invented.

## Environment notes
Docker is not installed on the dev machine, so PostgreSQL/Redis must be provided locally or Docker installed before Stage 3 integration tests can run.
