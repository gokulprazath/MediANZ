# Frontend decisions (Part A)

One line per assumption. Spec: `docs/FRONTEND_SPEC_A_NOW.md`.

## Stack and structure
- App lives in `/web`: Next.js 16.4 (App Router, Turbopack), React 19, TypeScript strict, Tailwind v4, shadcn/ui (radix, "nova" preset).
- Next.js 16 renamed middleware to `proxy`: route protection is `web/src/proxy.ts`.
- `cacheComponents` / `partialPrefetching` from create-next-app are turned off: data loads in the browser with TanStack Query, and session reads would otherwise need Suspense everywhere.
- FullCalendar is v7: plugins are imported from `@fullcalendar/react/daygrid` etc.; the separate v6 packages are not installed.
- Forms use a styled native `<select>` (`components/native-select.tsx`) instead of the Radix Select, for accessibility and mobile.
- Root `.gitignore` ignores `lib/`; `web/.gitignore` re-includes `web/src/lib/`.

## Data layer
- Every screen uses one interface, `DataApi` (`web/src/lib/data/api.ts`), implemented twice: `live.ts` (supabase-js with the user's session, RLS applies) and the mock store (`web/src/lib/mock/store.ts`).
- The mock store emulates each RLS policy, RPC body, trigger and check/exclusion constraint, and raises the same error messages, so `lib/errors.ts` maps both modes the same way.
- The mock database lives in the Next.js server's memory (`/api/mock`), so several tabs and portals share it (patient and clinician can consent from two windows). It resets on server restart or `POST /api/mock/reset`. It is not suitable for multi-instance hosting (e.g. Vercel serverless), only dev and tests.
- Mock seed = `supabase/seed/01–03` with the same ids. Rows the SQL creates with `gen_random_uuid()` get stable generated ids (prefix per table, e.g. slots `62000000-…`). "Today" is the UTC date, like Postgres `current_date` on Supabase.
- Mock logins mirror `02_link_test_logins.sql` (7 accounts), auth ids follow the backend fake data (`aa000000-…-0001` Olivia, `-0011` Dr Rao). Password `medianz-demo`; mock TOTP code `123456`. Clinicians and staff are pre-enrolled in MFA.
- Mock session is an unsigned httpOnly cookie `mz_mock_session` (uid, role, aal): no real accounts or data in mock mode.
- Mock auth sends no email: the page shows the link that would have been emailed.
- Mock transcription never sends or keeps audio: only the blob size goes to the server and a placeholder sentence is stored as the chunk text.
- History-aware edits (address, residency, insurance) are two requests in live mode (end current row, insert new), because Part A allows no new RPC; if the insert fails the ended row is reopened. A row that started today is corrected in place (valid_to must be > valid_from).
- "No private insurance" ends the current policy today.
- Realtime is only used for `appointment_slots` (Supabase channel filtered by clinician); mock mode polls every 2 s instead. Everything else polls through `useLiveQuery` (5 s default).
- `create rating` sends `patient_id` too; the trigger overwrites it from the appointment anyway.

## Auth and routing
- Role routing order is `lib/roles.ts` (`homePathFor`); `/` redirects on the server.
- `proxy.ts`: public paths are login/sign-up/reset/auth/privacy/mock API; `/staff` needs app_metadata.role staff/admin; `/clinician` and `/staff` need `aal2` and are signed out after 30 min idle (cookie `mz_last_active`, also refreshed by a client idle timer).
- Patient sign-up stores `user_metadata.signup_role = "patient"`; that is how step 4 of routing tells a new patient (onboarding) from an unlinked login ("not set up").
- Live email links go to `/auth/callback` (PKCE `code` or `token_hash`).

## Privacy and display
- The "What do you need help with?" text and the patient's location live only in React memory (`features/find-care/context.tsx`), never in URLs or browser storage.
- Staff clinic choice is stored in `localStorage` (clinic id only, no personal data).
- Suburb/postcode fallback uses a small local table, `web/src/config/postcodes.ts` (sample data's suburbs plus Brisbane/Sydney CBD).
- Emergency phrases are in `web/src/config/emergency.ts`; whole-phrase, case-insensitive match.
- Consent wording v1 is in `web/src/config/consent.ts` and is reused on the privacy page.
- Times are shown in the clinic's zone; the zone label is added when the clinic's UTC offset differs from the user's at that instant.
- The `.ics` file includes clinician, clinic, address and time, not the visit reason.
- Map flag colours: green = slot today, amber = within 7 days, grey = none; each pin also has an icon and a text label ("Today" / "This week" / "None").
- Clinic list "rating" sort uses the clinicians' averages weighted by rating count.

## Recording
- One recording file if the consult is 15 min or less; if it reaches 15 min, that file is sent as seq 1 and the recorder then restarts every 5 min (seq 2, 3, …). Each file comes from its own `MediaRecorder`, so every chunk is a complete file. Logic is in `features/consult/chunked-recorder.ts` (no React, unit-tested with a fake clock).
- A failed chunk is retried with the same seq after 2, 4, 8 and 16 s; then the page shows "Retry sending" (same seq again) or Cancel. Blobs stay in page memory only until their upload succeeds.
- Audio format: the first of `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4`, `audio/webm` the browser supports (Safari records mp4).
- Consent panel and recording controls are one shared component, `features/consult/consult-panel.tsx`, used by the patient's appointment-day page and the clinician's consult view.
- Only one device records: if a `recording_sessions` row is `started` by another user, the panel says "Recording on the clinician's (patient's) device" instead of Record.
- A `started` session by the same user with no recorder on this page (page closed mid-recording) is shown as "interrupted", with a Discard button (`cancel`).
- Leaving the page while recording stops the microphone and sends `cancel` (best effort); the browser also asks before unloading.
- If polling shows the other person's consent was withdrawn while recording, the recorder stops locally at once (the server deletes everything anyway).
- Withdrawing consent asks for confirmation and sends no reason (`withdraw_recording_consent(id, null)`).
- The recording indicator says "Recording" once (live region); the running time is a `role="timer"` that is not announced every second.
- The patient's consent panel shows while the visit is checked in or in consultation; the clinician's also shows while booked/confirmed (so they can agree early). Recording itself needs checked in or in consultation (the RPC's rule).
- Transcript speaker labels: segments are `c<seq>:<speaker>` and diarisation is per chunk, so speakers are numbered per part ("Speaker 1 (part 2)") and not matched across parts. Without segments the whole `transcript_text` is shown.
- Rejecting a transcript returns the patient to "My recordings and transcripts"; the draft is gone.

## Appointment day, consult and feedback
- Appointment-day and consult pages poll the appointment every 5 s (`useLiveQuery`), consents and recording sessions every 5 s too.
- "Complete consultation" asks for confirmation and reminds the clinician to stop recording first; the patient's panel unmounts when the visit completes, which cancels an unfinished recording on the patient's device.
- Clinician consult view shows "latest vitals" as the newest row of `visit_vitals_latest` for the patient, plus all `visit_vitals` rows of this visit; vitals can be added once checked in (also after completion, for late entries; the trigger decides).
- "Past visits with you" = the patient's earlier appointments with this clinician (any status), newest first, with reason, notes and fees.
- Clinician notes have no wording about who else can read them: staff can read appointment rows in Part A.
- Mark no-show (clinician) is offered for booked/confirmed visits whose start time has passed, as at the front desk.
- Feedback: optional sub-ratings can't be cleared once picked (star radio group); "would recommend" has Yes / No / Prefer not to say (null).
- Feedback is editable while `created_at` is within 30 days (the RLS rule); after that the page says so. "Anonymous" hides the name from the clinician only; the help text says staff can still see it.

## Staff visits, claims and moderation
- `FeesForm` (`features/appointments/fees-form.tsx`) is shared by staff visit detail and the clinician consult view. Gap follows fee − rebate (never below 0) until the user edits it; a saved gap that differs counts as edited.
- New claims default the amount to the visit's gap; status defaults to draft. Rejection reason is shown and saved only when status is Rejected (cleared otherwise).
- The "no policy on the visit date" trigger error is shown inline in the claim form and as a toast.
- Staff rating moderation lists ratings whose appointment is at the chosen clinic; the page says "never for being negative". Hidden and flagged both leave the star averages (the summary RPC counts only visible).
- `MODERATION_LABEL` lives in `lib/format.ts` (Next.js page files may only export page fields).

## Clinician portal
- Clinician screens use the time zone of their first current affiliation's clinic (`features/clinician/home-clinic.ts`); the calendar is in that zone, with the zone named when it differs from the browser's.
- Calendar: FullCalendar v7 classic theme, `en-au` locale, day view by default, 7 am to 8 pm in week/day views; rescheduled rows are left out (the new booking is shown); event text includes the status, so colour is not the only cue; a legend is shown. The "Today" button's accessible name is set to "Today" to match its text.
- My leave reuses `ExceptionsPanel` with only the clinician's own row and their affiliated clinics; extra sessions are not offered to clinicians (spec 5.4 says leave).

## Auth (fix)
- After a successful MFA code the app does a full page load to `next`: the client router had cached the pre-MFA redirect for that path and sent the user back to `/mfa`.

## Privacy page
- `/privacy` is a server page with the v1 consent wording from `config/consent.ts`, plus how health data, location and rating comments are handled and a "no medical advice" note with 000 and Lifeline.

## Find care and assistant booking
- The AI care finder and the clinic map are one page, "Find care" (`/patient/find`): describe the problem, then AI matches (ranked cards, numbered and highlighted pins, map zooms to them) or all clinics (the directory list) in tabs. `/patient/concierge` redirects; nav has one "Find care" item; home's "Find care with AI" opens `/patient/find?ai=1`, which searches once the location and reason are set.
- Map pins: the accessible name (`title`) starts with the visible label (WCAG 2.5.3); the map follows the system light/dark scheme (`colorScheme="FOLLOW_SYSTEM"`). The map id stays `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`, else `DEMO_MAP_ID`.
- The assistant books through a new least-privilege `booking` agent (`find_gp_candidates`, `get_available_slots`, `propose_booking`). `/chat` returns `booking_proposal` (id, summary, expiry); the chat shows a card and only the patient's Confirm calls `confirm_booking_proposal` (Decline calls `decline_booking_proposal`). One proposal per message. Mock mode mirrors it (soonest GP time in 14 days).

## Demo login for evaluators
- Login has a third tab, "Demo account" (`/login?demo` opens it): Patient (Olivia Brown), Clinician (Dr Asha Rao) and Receptionist (Southbank front desk), one clinic so the three roles meet. Each lands on its portal home with that role's full access.
- Live mode: `POST /api/demo-login` signs in on the server with the demo password (anon key; RLS applies; never the service role) and sets an HttpOnly `mz_demo` cookie (12 h). The proxy skips the MFA (aal2) step for `/clinician` and `/staff` only when that cookie names the demo role of the signed-in demo account and `DEMO_LOGIN_ENABLED=true`; password and email-link sign-ins of the same accounts still need MFA, and the 30-minute idle sign-out still applies. RLS does not check aal, so access is otherwise unchanged. Shown only with `NEXT_PUBLIC_DEMO_LOGIN=true`. Mock mode: the same tab uses the mock password and code.
- Shared sample data, no reset: evaluators see each other's changes (the hosted database is never reset).

## Recording consent v2 and Olivia's demo data
- The consent panel now shows and records wording `v2` (covers AI analysis, "AI help with the notes"). With `v1`, `get_processing_eligibility` returned `*_consent_version_excludes_ai`, so transcripts recorded in the app were never drafted by the consult-notes worker. Earlier `v1` consents stay valid for recording.
- `supabase/seed/07_olivia_demo_data.sql` (re-runnable): two more past visits with Dr Rao (one at Paddington, where she worked until 90 days ago), vitals, ratings, an approved transcript of the fatigue visit (queued for the worker), an answered GP question, a review in two weeks, and a visit checked in now with Olivia's consent, so recording works at any hour. Booked visits not checked in become no-shows 30 minutes after their start (pg_cron), which is why the seed checks this one in. The web mock mirrors the history (ids 201/202), not the checked-in visit.

## Assistant conversation
- The conversation lives in `ConversationProvider` in the patient layout (memory only, never browser storage): it survives moving between patient pages, a reply arriving after the patient left still lands, and it ends on sign-out or when another patient signs in. Each message sends the last 12 turns (2000 characters each, under the proxy's 32 KB limit) so follow-ups make sense.
- A drafted GP question shows who it goes to ("To Dr Asha Rao, about your visit on ..."); booking and question outcomes are kept on the turn, so returning to the page never re-offers a confirmed booking.

## Tests
- Unit tests (`tests/unit`, Vitest, jsdom, TZ Australia/Brisbane) use the mock store directly with a fixed "now" (Friday 30 Oct 2026, 11 am Brisbane).
- E2E (`tests/e2e`, Playwright, Chromium only) run one at a time against `next dev` on port 3100 in mock mode; each test resets the mock database. `PW_CHROMIUM_PATH` lets the suite use a preinstalled Chromium when it differs from Playwright's pinned build.
- E2E consent/recording uses appointment `…0103` (Priya with Dr Williams, no seeded consent); the withdrawal test uses `…0101`, where the seed has Olivia's consent already (as `03_*.sql` does).
- axe runs with WCAG 2.0/2.1/2.2 A and AA tags; the suite fails on any serious or critical violation.

## Part B (needs backend work, not built)
- None found in Part A's phases 4–7: every screen worked with the existing tables, RLS, RPCs and the Edge Function.

# Part B (hackathon scope: agent features visible in the app)

## Scope
- Built: patient AI assistant (B5), AI care finder (B4 + B5 booking), clinician review queue (B6), Realtime + self check-in (B1), staff AI operations (B8). Not built: staff clinic scoping and invites (B3), reminders and notifications (B2), public/private rating split (B7), care follow-ups (B8), voice input, red-team suite (B9). Reason: not visible in a demo.
- Not tested against live Supabase or the Python services: this container has no Supabase credentials and the network policy blocks supabase.co. Mock mode covers the same contracts; live needs a manual run (README "Part B: live").

## Backend added (one migration, `20261030000000_partb_live_agents.sql`)
- Realtime publication gains `appointments`, `recording_consents`, `recording_sessions`, `gp_queries` (RLS applies to Realtime).
- `patient_check_in(appointment_id)`: security definer, the appointment's patient only, 30 min before to 15 min after the start; the existing trigger records `checked_in_at`.
- New policy: the appointment's patient reads their `gp_queries` (before, only the treating clinician and staff could), so "My questions" can show answers.
- `get_agent_activity(hours)` / `get_engine_activity(hours)`: staff-only security-definer aggregates over `agent_access_log` / `decision_log` (counts, errors, latency; no ids or text). The logs themselves stay closed to `authenticated`.

## Connecting to the agent services
- The browser never calls the Python services directly: `/api/agents/...` (Next route handler) forwards an allowlist of endpoints with the user's Supabase access token. Allowed: agent `/chat`, `/chat/confirm`; discovery `/v1/services`, `/v1/discovery`, `/v1/availability`, `/v1/holds`, `/v1/bookings`, `/v1/research/drafts` (+ approve/reject). `/extract` and the research job are not exposed.
- Service URLs are server-only env vars, `AGENT_SERVICE_URL` (agent.py, default port 3108) and `DISCOVERY_SERVICE_URL` (healthmcp.discovery.app, port 3109 in the root README). No CORS setup is needed on the services; the CSP is unchanged (same origin).
- The proxy never logs request or response bodies (they can hold health questions). FastAPI `{detail}` errors are normalised to `{error}`.
- Mock mode answers `/api/agents/...` from `lib/mock/agents.ts`: deterministic rules over the mock database with the same shapes and error codes (`NEEDS_SERVICE_CLARIFICATION`, `SLOT_TAKEN`, `QUOTE_CHANGED`, ...). It is a stand-in for tests and offline demos, not a model.
- Money from the discovery API is a string (Pydantic Decimal); the UI formats it with `Intl` and never does arithmetic on it.

## Patient AI assistant (`/patient/assistant`)
- The agent service's deterministic router picks the agent; the UI labels each reply ("Records agent", "Insurance agent", "Fees and matching agent") with what it may do.
- The GP-question draft is shown from the signed action token's body (base64url JSON: question, appointment, expiry; display only). The patient can approve or not send it; they can't edit it, because the service signs the exact text. To change it they ask again in their own words.
- Conversation is page memory only (no browser storage); "Clear conversation" empties it. The emergency banner shows when the draft or any sent message contains emergency words.
- "My questions" lists the patient's `gp_queries` with answers (new policy above), updated by Realtime in live mode.

## AI care finder (`/patient/concierge`)
- Uses the discovery API: problem text (or a chosen service) + location + radius → ranked clinics with the AI summary, cost breakdown (fee, Medicare rebate, insurance benefit, estimated gap), coverage note and "Why this clinic?" factor scores (bars with numbers, so not colour only).
- Booking: hold → confirm card with countdown → `/v1/bookings` with `expected_fee`/`expected_gap` and a per-tap idempotency key. `QUOTE_CHANGED` shows the new price and needs another tap; `SLOT_TAKEN` searches again. Nothing books without the patient's tap.
- The problem text is the booking reason; it stays in the find-care memory context like Part A's "What do you need help with?".
- The page doesn't wrap the location picker in a form (the picker has its own).
- Nav: "AI care finder" and "AI assistant" added; the map is now "Clinic map". Home gets "Find care with AI" next to the map button.

## Clinician review queue (`/clinician/review`)
- One shared component (`features/review/review-queue.tsx`) for the queue page and the appointment view. Order: urgent open items (by severity), patient questions, then each visit's open items, key points and facts.
- Key points show confidence against the question's threshold ("below threshold" when lower) and the second opinion when present; edit uses the question's options (or text for explain questions).
- Fact edit builds the jsonb value from the field's JSON Schema (object of strings/numbers, number, or enum); other schema shapes fall back to a text value.
- "Show transcript evidence" loads `transcript_segments` and shows the cited segments (treating clinician only, by RLS).
- Nav shows "Review queue (N)"; it polls every 15 s and, in live mode, refreshes on `consult_note_runs` and `gp_queries` changes.
- The appointment view gains "Clinical record (AI drafted, clinician approved)": approved facts for the patient, approved key points of this visit, the consult-notes run status, and this visit's drafts.
- Mock mode emulates the consult-notes worker: approving a transcript creates draft key points, facts and open items from keyword rules, so the demo flow works end to end. The seed already has drafts for Olivia's visit …0002 and one open question from her.

## Realtime and self check-in
- `useLiveQuery` takes optional `realtime` sources; in live mode it subscribes and refetches on change, and polling drops to a 30 s fallback. Mock mode still polls every 5 s.
- Appointment-day page: "I've arrived" shows from 30 min before to 15 min after the start; otherwise it says when check-in opens or that it has closed.

## AI operations (`/staff/operations`)
- Totals (tool calls, error rate, items waiting, oldest wait), per-agent/tool table, engines with "May receive health data" / "No health data" from `model_registry`, the human review backlog, and research drafts (approve/reject via the discovery API).

## Tests
- E2E port moved from 3100 to 3200, because the MCP gateway uses 3100.
