# Campaign Sender (CommHub Web)

A minimal, free-first campaign communication tool built into this repository.

The principle: **UPLOAD DATA → SELECT ACTION → EXECUTE → SEE RESULTS**

## What changed in this project

The old web console was a complex 12-section enterprise dashboard (login, approvals,
audit trails, queue monitors, charts). It had **no working WhatsApp feature**, no
client-side Excel import, and a "mass call" button that falsely reported every call as
`COMPLETED` even though nothing was dialed.

The backend (NestJS API + PostgreSQL + Redis worker + provider adapters) was preserved
and is still available for the optional automated voice-calling integration. Two
backend changes were made:

1. `apps/api/src/campaigns/campaigns.module.ts` – `quickMassCall` no longer fakes
   success. Without a real telephony provider configured (Twilio keys) it now
   returns an honest error **before** creating any campaign, and it no longer marks
   simulated calls as `COMPLETED`.
2. The old frontend (`apps/web/src/Layout.tsx`, `pages.tsx`, `auth-context.tsx`,
   `api.ts`) was replaced by the new simple wizard below. It remains fully
   recoverable from git history if the admin console is ever needed again.

## How to run it

```bash
# from the repository root
npm run build:packages
npm run dev -w @commhub/web      # opens http://localhost:5173
```

No login, no registration, no database required. Everything happens in the browser.

## The three steps

### Step 1 – Upload Contacts
- Accepts `.csv`, `.xlsx` and `.xls` files (SheetJS, free and open source).
- Column names are auto-detected and mapped to **Name / Phone / WhatsApp number /
  Category**; every other mapped column becomes a message template variable.
- Phones are validated and normalised to international `E.164` format
  (libphonenumber-js). A default country (e.g. `IN`) is applied for numbers typed
  without a `+` code.
- Duplicates (within and across imported files) are flagged; invalid rows are shown
  with the reason and can be removed with one click.
- You select individual contacts with checkboxes. Data lives in `localStorage` only –
  nothing is uploaded anywhere until you explicitly run a voice campaign.

### Step 2 – Message and Method
- Campaign name, message text, and one of three communication methods.
- Placeholders: `{{name}}`, `{{phone}}`, `{{category}}` plus one chip per extra
  column. `Hello {{name}}, we would like to connect with {{business}}` becomes
  `Hello Rahul, we would like to connect with ABC Traders`. A live preview shows the
  substitution for the first contact.
- Consent confirmation is required before execution.

### Step 3 – Send and Results
- Counters: **Done / Pending / Failed / Skipped**, a progress bar, and a
  CSV download of the results.
- **Pause / Resume / Stop** and **Retry failed & skipped** are provided.

## What genuinely works for free

| Feature | How |
|---|---|
| CSV / Excel contact import + column mapping | Fully client-side (SheetJS) |
| Phone validation and E.164 normalisation | libphonenumber-js |
| Duplicate detection | Client-side by phone number |
| Personalised WhatsApp links (`wa.me`) with prefilled text | Browser native |
| Click-to-call `tel:` links | Browser native (or handset dialler) |
| Message preview with placeholders | Client-side |
| Campaign progress, pause/resume/stop, retry, results export | Client-side state |
| Contact data privacy | `localStorage` only + one-click *Clear all data* |

Important honesty notes:

- **WhatsApp cannot be sent automatically.** Opening a `wa.me` link opens the chat
  with the message pre-filled; *you* press send. Anything else needs the paid,
  official WhatsApp Business API and explicit authorisation.
- **The browser cannot complete a phone call silently.** `tel:` links open the
  dialler (on desktop: FaceTime/Teams/mobile companion app); the OS or you completes
  the call, and the browser cannot know the outcome - which is why you mark the
  result.

## What genuinely requires a paid external service

| Feature | Requirement |
|---|---|
| Prerecorded voice campaigns (automated PSTN calls playing an MP3/WAV) | A telephony provider account such as Twilio. No free service provides outbound voice calls; this is a telecom reality, not a design choice. |
| Automated WhatsApp sending | Official WhatsApp Business API. |

### Voice campaign configuration (optional integration layer)

1. Deploy/run the API (`apps/api`) with PostgreSQL and Redis (see `docs/setup.md`,
   `docker compose -f infra/docker-compose.yml up -d`).
2. Set on the API server: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_PHONE_NUMBER`.
3. In the app choose **Prerecorded voice campaign** → *Check API connection*.
   The app reports honestly whether a provider is connected. When none is
   configured the *Start voice campaign* button stays disabled with a plain-English
   explanation, and the API refuses `POST /campaigns/quick-call` without a provider
   instead of faking success.
4. When connected: your MP3/WAV (max 10 MB / 180 s) is uploaded to the API, and the
   selected recipients are submitted to the provider. The response reports how many
   call requests the provider **accepted** and how many were rejected or opted out.
   Accepted is not the same as answered - final outcomes appear in the API reports
   as the provider reports them.

The default API endpoint can be changed with `VITE_API_BASE_URL`
(create `apps/web/.env.local`) or left as `http://localhost:3000` for local
development (Vite also proxies `/api` in dev).

## Testing report

Executed against the repo with Vitest and production build:

- `npm run test -w @commhub/web` – **12/12 tests pass**
  - phone normalisation: local format, leading zero, +country code, invalid values
  - template substitution: known/unknown placeholders, extra mapped columns
  - `wa.me` and `tel:` link generation incl. URL-encoded message text
  - import mapping: guessed columns, extra column variables, duplicate flagging,
    invalid row reasons
  - UI walkthrough: upload step gating, compose preview, send step wording,
    manual result marking, honest "no provider configured" state
- `npm run build -w @commhub/web` – production build succeeds (tsc + vite)
- `npm run build -w @commhub/api` – backend compiles after the honesty fix
- Dev server smoke test – app serves HTTP 200 with the new UI

Not verified here (needs real devices/network):
- that `wa.me` links open WhatsApp on *your* device (behaviour is WhatsApp's own)
- that `tel:` opens your dialer on mobile (device-specific)
- a real Twilio voice call end-to-end (needs a paid Twilio account; the code path
  uses the pre-existing provider adapter and stream endpoint)

## Removed jargon, on purpose

No dashboard charts, no approval queues, no audit logs, no team management, no
queue monitor in the UI. The backend still has those capabilities if the admin
console is restored from git history.
