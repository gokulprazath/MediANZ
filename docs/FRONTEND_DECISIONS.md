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
- Plan (not built yet): one recording file if the consult is 15 min or less; if it reaches 15 min, that file is sent as seq 1 and the recorder then restarts every 5 min (seq 2, 3, …). Failed chunks retry with the same seq; blobs stay in memory only.
