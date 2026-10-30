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

## Tests
- Unit tests (`tests/unit`, Vitest, jsdom, TZ Australia/Brisbane) use the mock store directly with a fixed "now" (Friday 30 Oct 2026, 11 am Brisbane).
- E2E (`tests/e2e`, Playwright, Chromium only) run one at a time against `next dev` on port 3100 in mock mode; each test resets the mock database. `PW_CHROMIUM_PATH` lets the suite use a preinstalled Chromium when it differs from Playwright's pinned build.
- E2E consent/recording uses appointment `…0103` (Priya with Dr Williams, no seeded consent); the withdrawal test uses `…0101`, where the seed has Olivia's consent already (as `03_*.sql` does).
- axe runs with WCAG 2.0/2.1/2.2 A and AA tags; the suite fails on any serious or critical violation.

## Part B (needs backend work, not built)
- None found in this round: every Phase 4–7 screen works with the existing tables, RLS, RPCs and the Edge Function.
