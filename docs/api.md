# REST API Reference (`docs/api.md`)

Interactive OpenAPI/Swagger documentation is served at **`GET /api/docs`** when the API is running. All protected endpoints require `Authorization: Bearer <accessToken>` and enforce server-side role permissions via `AuthGuard`.

## Authentication (`/api/auth`)
- `POST /api/auth/login` — `{ email, password, mfaCode? }` → sets `HttpOnly`, `SameSite=Strict` refresh cookie (`/api/auth`) and returns `{ accessToken, user }` (rate-limited).
- `POST /api/auth/refresh` — rotates the refresh session; reuse of a revoked token revokes all sessions for that user.
- `POST /api/auth/logout` — revokes the current refresh session.
- `GET /api/auth/me` — returns the authenticated user.
- `POST /api/auth/mfa/setup` & `POST /api/auth/mfa/enable` — optional TOTP MFA enrolment.

## Users (`/api/users`) — `users:manage` (`ADMIN`)
- `GET /api/users` — list staff accounts (password hashes and MFA secrets are never returned).
- `POST /api/users` — create user (`min 12` char password).
- `PATCH /api/users/:id` — update role/active state (self-role change and self-deactivation are forbidden; deactivating a user immediately revokes their sessions and invalidates active access tokens).

## Contacts & Suppressions (`/api/contacts`)
- `GET /api/contacts/template.csv` — downloadable CSV template (`contacts:read`).
- `POST /api/contacts/imports/preview` — multipart CSV upload; validates headers, E.164 phone numbers, consent timestamps, detects in-file and existing duplicates, flags suppressed numbers, and ignores/warns on sensitive columns (`contacts:import`).
- `POST /api/contacts/imports/:id/commit` — commits a previewed batch (`contacts:import`).
- `GET /api/contacts` — paginated search/filter (`contacts:read`).
- `POST /api/contacts` / `PATCH /api/contacts/:id` — create or correct contact (`contacts:import`).
- `DELETE /api/contacts/:id` — deletion request: removes contact and adds phone to `Suppression` (`contacts:suppress`).
- `GET /api/contacts/suppressions` / `POST /api/contacts/suppressions` — view or add opt-out/suppression records.

## Content (`/api/voice-announcements`, `/api/sms-templates`)
- `POST /api/voice-announcements` — upload WAV/MP3/OGG (verifies file signature, size ≤10 MB, duration ≤180s).
- `GET /api/voice-announcements/:id/stream` — authenticated audio stream.
- `POST /api/voice-announcements/:id/review` — approve/reject (`campaigns:approve`).
- `POST /api/sms-templates/estimate` — GSM-7 / UCS-2 character & segment calculator.
- `POST /api/sms-templates` / `POST /api/sms-templates/:id/review` — create and approve SMS templates.

## Campaigns (`/api/campaigns`)
- `GET /api/campaigns` / `GET /api/campaigns/:id` — list and inspect campaigns with status history and outcome counts.
- `POST /api/campaigns` / `PATCH /api/campaigns/:id` — create/edit draft (`audience` schema strictly rejects unrecognised/sensitive attributes).
- `POST /api/campaigns/:id/submit` — submit draft for approval (requires approved template/audio and >0 eligible contacts).
- `POST /api/campaigns/:id/approve` / `POST /api/campaigns/:id/reject` — maker-checker enforced (`createdById !== approverId`).
- `POST /api/campaigns/:id/schedule` — snapshots eligible recipients and writes `OutboxEvent` in one transaction.
- `POST /api/campaigns/:id/pause` / `resume` / `cancel` — operational controls.

## Webhooks (`/api/webhooks`)
- `POST /api/webhooks/:channel` (`voice` | `sms`) — verifies `x-signature` HMAC-SHA256 over raw body, validates payload, deduplicates via unique `(provider, eventId)`, prevents out-of-order status regression via `OutcomeRank`, and records provider-reported costs or opt-outs.
- `POST /api/webhooks/simulate/campaign/:id` & `POST /api/webhooks/simulate/event` — authorised callback simulator (`MOCK` mode only).

## Reports, Queues & Settings
- `GET /api/dashboard/summary` — overview metrics.
- `GET /api/queues/health` — BullMQ queue counts, failed jobs, outbox counts, and recent `JobRecord` rows.
- `GET /api/reports/outcomes` / `GET /api/reports/export.csv` — outcome & internal cost reports; CSV masks phone numbers by default.
- `GET /api/audit-logs` — paginated audit trail (`audit:read`).
- `GET /api/providers` / `PATCH /api/providers/:id` — provider config & production readiness blockers (`providers:manage`).
- `GET /api/settings`, `POST /api/settings/emergency-stop`, `PATCH /api/settings/operating-window`, `PATCH /api/settings/compliance/:key`.
