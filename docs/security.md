# Security, Privacy & Compliance Controls (`docs/security.md`)

## 1. Authentication & Authorisation
- **Password hashing**: `bcryptjs` with cost factor 12 and minimum 12-character password policy.
- **Session handling**: short-lived HS256 access JWT (15 minutes) + rotating random refresh token stored as a SHA-256 hash in PostgreSQL (`Session`) and sent only in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`. Reuse of a revoked refresh token immediately revokes all sessions for that user and logs `auth.refresh_reuse_detected`.
- **Immediate revocation**: `AuthGuard` reloads the user record on every request, so deactivating a user or changing their role takes effect immediately without waiting for JWT expiry.
- **Rate limiting & lockout**: global throttler + strict login rate limit + account lockout after 5 failed attempts.
- **Server-side RBAC**: every non-public controller route is guarded by `@RequirePermissions(...)`; routes without a permission policy are denied by default. Self-privilege escalation and self-approval (maker-checker) are blocked server-side.

## 2. Data Minimisation, Privacy & Anti-Abuse Safeguards
- **No scraping or inferred consent**: every contact requires an explicit `source`, `lawfulBasis`, and past/present `consentAt` timestamp.
- **No sensitive profiling**: the CSV importer warns on and discards columns matching religion, caste, ethnicity, political party/vote, health, disability, biometric, or sexual orientation (`SENSITIVE` regex in `packages/domain/src/csv.ts`). Campaign `audience` uses `.strict()` Zod validation allowing only operational `sources`.
- **Suppression & deletion**: `Suppression` is keyed by E.164 phone number so opt-outs survive contact deletion. `DELETE /api/contacts/:id` deletes the contact and inserts a suppression record in the same transaction.
- **Export masking**: `GET /api/reports/export.csv` masks phone numbers (`+9198******10`) unless requested by an `ADMIN` with `includeFullPhone=true`, and logs every export in `AuditLog`.
- **Audio & file safety**: private storage keys are server-generated (`audio/<timestamp>_<random>.wav`); `LocalStorage` enforces path-traversal containment; audio uploads verify magic bytes (`RIFF/WAVE`, `OggS`, `ID3`/MPEG sync), MIME type, size (≤10 MB), and duration (≤180s).

## 3. Legal & Regulatory Notice (India / Public Communications)
> **Important:** This software provides technical and operational safeguards, but **software alone cannot guarantee legal compliance**. Before any production deployment (including in India):
> 1. Verify applicable **TRAI Telecom Commercial Communications Customer Preference Regulations (TCCCPR)** and **DLT** entity, header/sender ID, and template registrations.
> 2. Verify **Election Commission of India (ECI)** Model Code of Conduct rules, pre-certification requirements for political advertisements/voice calls, silence-period restrictions (e.g. 48 hours prior to close of poll), and expenditure accounting rules.
> 3. Verify obligations under the **Digital Personal Data Protection Act, 2023 (DPDP Act)** or other applicable privacy law.
> 4. Obtain **explicit written approval from the telecom/cloud telephony provider** confirming that political or public-service communication is permitted on the account.
>
> Until all of the above are verified, configured, and checked off in Settings, `productionBlockers()` keeps real sending disabled.
