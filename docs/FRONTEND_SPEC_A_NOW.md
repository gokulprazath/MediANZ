# MediANZ frontend: Part A (build now, no backend changes)

You are building the MediANZ web app: one website with three portals
(patient, clinician, clinic staff). **Part A uses only the backend that already
exists. It must not need any new SQL, Edge Function or server.** Everything
that needs backend work is in `docs/FRONTEND_SPEC_B_LATER.md`; do not build it now.

Read this file, `CLAUDE.md` and every SQL file in `supabase/migrations/` and
`supabase/seed/` before starting. Work in the phases in section 8 and stop for
review at the end of each.

---

## 1. Rules

- **Never connect to Supabase yourself** (no queries, CLI or API calls). Do not
  write any SQL. If something in this spec turns out to need a backend change,
  stop, explain why, and move it to Part B in `docs/FRONTEND_DECISIONS.md`.
- Use only these backend pieces (read their exact definitions in the SQL files):
  - migrations `20261026000000_health_booking_schema.sql`,
    `20261026010000_security_advisor_fixes.sql`, `20261026020000_visit_vitals.sql`,
    `20261028100000_chunked_transcription.sql`
  - the Edge Function `supabase/functions/transcribe-consult/index.ts`
  - **Not** the agent-layer tables or the MCP servers (those are Part B).
- The browser uses only the **anon/publishable key** and the signed-in user's
  session, so RLS applies to everything. The service role key never appears in frontend code.
- Never write directly to `appointments` or `appointment_slots` rows for
  booking; use the RPCs: `get_available_slots`, `hold_slot`, `book_slot`,
  `cancel_appointment`, `reschedule_appointment`.
- Health data never goes into analytics, error trackers, URLs, `localStorage` or
  console logs.
- **Mock mode** (`NEXT_PUBLIC_DATA_MODE=mock`, default): every screen works with
  a mock data layer built from `supabase/seed/` (same ids, names and dates
  relative to today). `live` mode uses the real Supabase project; I run that.
- No AI chat, no diagnosis, no clinical advice anywhere in Part A.
- Keep `docs/FRONTEND_DECISIONS.md` (one line per assumption).

---

## 2. Tech stack

- **Next.js** (App Router) + **TypeScript** (strict) + **Tailwind CSS** + **shadcn/ui**.
  Check the installed versions' docs; don't rely on memory.
- **Supabase:** `@supabase/supabase-js` + `@supabase/ssr` (cookie sessions, middleware route protection).
- **Data:** TanStack Query. **Forms:** react-hook-form + zod (validation mirrors the SQL `check` constraints).
- **Map:** Google Maps JavaScript API via `@vis.gl/react-google-maps`
  (`NEXT_PUBLIC_GOOGLE_MAPS_KEY`, restricted by HTTP referrer). In mock mode, if
  no key is set, show the list view only with a "map needs an API key" note.
- **Calendars:** FullCalendar (clinician and staff); a custom date-strip + slot grid for patients.
- **Realtime:** only `appointment_slots` is published for Realtime today. For
  everything else (appointment status, consents, recording state) **poll every
  5 seconds** while the screen is open, behind a small `useLiveQuery` hook so
  Part B can switch it to Realtime without touching screens.
- **Tests:** Vitest + Testing Library; Playwright end-to-end in mock mode, with axe accessibility checks.
- **Types:** hand-written in `src/types/db.ts`, mirroring the SQL exactly.
- Mobile-first, WCAG 2.2 AA, Australian English. Show times in the **clinic's
  timezone** (`facilities.timezone`), with the zone label when it differs from the user's.

```
/web
  /src/app/(auth) /patient /clinician /staff /api
  /src/components  /src/features  /src/lib  /src/types
  /tests
```

---

## 3. Authentication and roles

- One login page (email + password, magic link, password reset).
- After login, route by role, checked in this order:
  1. `app_metadata.role` is `staff` or `admin` → `/staff`
  2. a `clinicians` row with `auth_user_id = user.id` → `/clinician`
  3. a `patients` row with `auth_user_id = user.id` → `/patient`
  4. otherwise: patient onboarding (step 1 of the profile) if they signed up as
     a patient, or "Your account isn't set up yet" if not.
- **Patient sign-up:** email verification, then the onboarding form inserts their
  `patients` row with `auth_user_id = auth.uid()` (allowed by RLS).
- Clinician and staff accounts are created by me in the dashboard (no
  self-sign-up, no invites in Part A).
- **MFA (TOTP)** for clinicians and staff using Supabase Auth MFA; middleware
  requires `aal2` for `/clinician` and `/staff`. Clinician/staff idle timeout 30 minutes.
- Footer on every page: "For emergencies call 000."

---

## 4. Patient portal

### 4.1 Profile (`/patient/profile`), editable any time
Each section saves on its own; a completeness indicator at the top.
- **Personal:** first/last/preferred name, date of birth, sex, gender identity, email, phone (`patients`).
- **Medicare:** number (10 digits), IRN (1–9), expiry; IHI optional (16 digits).
- **Emergency contact:** name, phone, relationship.
- **Blood type.**
- **Address** (`patient_addresses`, history-aware): changing an address sets
  `valid_to = today` on the current row and inserts a new one from today. Past
  addresses are shown read-only. Never delete rows (patients can't, by design).
- **Residency / visa** (`patient_residency`, history-aware the same way), picking
  from `residency_statuses`.
- **Insurance** (`patient_insurance_policies`, one at a time, history-aware),
  picking provider → plan from `insurance_providers` / `insurance_plans`; or "No private insurance".
- **My recordings and transcripts:** list from `recording_sessions` and
  `consult_transcripts` with status; link to review drafts (4.6).

### 4.2 Home (`/patient`)
- Upcoming appointment card, with a **banner from 4 hours before** the start
  ("Your appointment with Dr Rao is at 2:30 pm today"), computed in the app.
- "Find care": a text box "What do you need help with?" (saved as the booking
  **reason** later; text only in Part A), a radius input in km (1–100,
  default 10), and location from browser geolocation, or a suburb/postcode if
  denied (map the sample postcodes to coordinates with a small local table;
  record this in FRONTEND_DECISIONS.md). Never store the location.
- If the text contains emergency words (chest pain, can't breathe, suicidal…,
  list in one config file), show an emergency banner (000, Lifeline 13 11 14) first.

### 4.3 Map (`/patient/find`)
Built entirely from tables readable by any signed-in user:
- Clinics from `facilities` (with `latitude`/`longitude`), filtered by distance
  from the patient (haversine, in the browser), within the chosen radius.
- Clinicians at each clinic from `clinician_affiliations` valid today, joined to `clinicians`.
- **Flag colour by availability** (one call to `get_available_slots` per day for
  the next 7 days, per clinic): green = a slot today, amber = within 7 days,
  grey = none. A legend is always visible, and each pin also shows a text label
  or icon, so colour is never the only cue.
- **Hover/tap card:** clinic name, address, distance, facility type, current
  billing policy (`facility_billing_policies` valid today: bulk billed / mixed /
  private only), next available time, clinicians (name, type, specialty,
  qualifications), star rating per clinician (`get_clinician_rating_summary`,
  averages only, never comments), phone. "Book with Dr X" buttons.
- A list view under the map with the same data, sortable by distance, next available, rating.

### 4.4 Booking (`/patient/book/[clinicianId]?facility=…`)
- Date strip (next 8 weeks) and slot grid per day from `get_available_slots`
  (filtered by clinician and facility), in the clinic's timezone.
- Selecting a slot → `hold_slot` (5-minute hold, countdown) → confirm screen
  (reason pre-filled from 4.2, visit type) → `book_slot`.
- **Realtime** on `appointment_slots` for that clinician: slots taken by others
  disappear instantly; if the held slot is lost, explain and return to the grid.
- Confirmation page with "Add to calendar" (.ics from a Next.js route; it
  builds the file from the appointment the user can already read; nothing is stored).
- **My appointments** (`/patient/appointments`): upcoming and past, status and
  status history (`appointment_status_history`); cancel (`cancel_appointment`)
  and reschedule (pick a new slot → `reschedule_appointment`).

### 4.5 Appointment day (`/patient/appointments/[id]/live`)
- Shows status, polled every 5 s. Check-in is done by reception (Part A); the
  page says "Please check in at reception".
- When status is `checked_in` or `in_consultation`: the **consent panel**:
  what is recorded, that audio is not stored, who can see the transcript,
  Agree → `give_recording_consent(appointment, 'v1', 'in_app')`; shows whether
  the clinician has consented (from `recording_consents`, polled).
  "Withdraw consent" → `withdraw_recording_consent`.
- When both have consented: **recording controls** using `transcribe-consult`
  (read its header comment): `start` → record with `MediaRecorder` → send as one
  file, or, if longer than 15 minutes, restart the recorder every 5 minutes and
  send each complete file as the next `seq` → `finish`. Retry a failed chunk
  with the same `seq`. A clear "Recording" indicator; Stop and Cancel buttons.
  If the recording is already running on the clinician's device, show
  "Recording on the clinician's device" instead of a second Record button.

### 4.6 Transcript review (`/patient/transcripts/[id]`)
- Draft (`pending_patient_review`): full text with speaker turns, the deadline
  (`review_expires_at`), Approve (`approve_transcript`) / Reject (`reject_transcript`, with confirm).
- Approved: read-only.

### 4.7 Feedback (`/patient/appointments/[id]/feedback`)
- Shown for `completed` appointments (within 30 days): star rating, communication
  and wait-time ratings, would recommend, optional comment, anonymous option →
  insert into `clinician_ratings` (RLS enforces completed + own visit).
- Editable for 30 days. Comments are **never shown publicly** in Part A (only
  star averages), because the public/private split for Ahpra comes in Part B.
  Help text: "Your comment goes to the clinic. Please don't include medical details."

---

## 5. Clinician portal

### 5.1 Calendar (`/clinician`)
- Day / week / month (FullCalendar) of the clinician's own appointments (RLS),
  coloured by status; today by default; polled every 30 s.

### 5.2 Appointment view (`/clinician/appointments/[id]`)
- Patient summary from what clinicians can read: name, age, sex, contact,
  emergency contact, reason, visit type, past visits with **this clinician**
  (dates, reasons, notes, fees), latest vitals (`visit_vitals_latest` /
  `visit_vitals`), approved transcripts of their visits.
- **Consult controls:** Start consultation (status → `in_consultation`),
  consent panel for the clinician (synced by polling with the patient's),
  recording controls (same as 4.5), vitals entry form (`visit_vitals`
  insert, validation matching the SQL ranges, BMI shown), clinical notes,
  fees (fee charged, Medicare rebate, gap), Complete (status → `completed`).
- Mark no-show for past unattended bookings.

### 5.3 My ratings (`/clinician/ratings`)
- `get_my_ratings_as_clinician()`; anonymous shown as such.

### 5.4 My leave (`/clinician/leave`)
- Add/remove own leave in `schedule_exceptions` (allowed by RLS; slots are
  blocked automatically). Show bookings that clash with the new leave.

---

## 6. Staff portal (clinic admins and receptionists)

Part A limitation, shown as a banner in development: staff can see **all
clinics** (the backend's staff role is global). The portal starts with a
**clinic picker** and filters every screen by the chosen clinic; real
per-clinic security comes in Part B. Admin and receptionist see the same screens in Part A.

### 6.1 Front desk (`/staff`)
- Today's appointments for the clinic, by clinician; **check in** (status →
  `checked_in`, arrival time recorded automatically), mark no-show, cancel.
- Book on behalf of a patient: search patients, pick a slot →
  `book_slot(..., p_channel => 'reception' or 'phone', p_patient_id => …)`.
- Register a new patient (staff can insert `patients` rows).

### 6.2 Slots and schedules (`/staff/schedules`)
- Day board per clinician: slots with status; block / unblock individual
  slots (update `appointment_slots.status`; never touch booked ones).
- Leave and extra sessions (`schedule_exceptions`): slots update automatically.
- Weekly schedule (`clinician_schedules`): edits take effect when the nightly
  job regenerates slots. Say so in the UI ("new slots appear overnight").

### 6.3 Clinicians (`/staff/clinicians`)
- List clinicians affiliated with the clinic; create/edit clinician profiles,
  qualifications, registration history, affiliations (start/end dates,
  role, Medicare provider number). History rows are ended, never overwritten.
- Login linking stays manual (dashboard + `02_link_test_logins.sql`); note this in the UI.

### 6.4 Visits, fees and claims (`/staff/visits`)
- Visit list with filters (date, clinician, status); detail with arrival time,
  wait (consult start − check-in), consult length, fees.
- Edit fee charged, Medicare rebate and gap on a visit.
- Insurance claims (`insurance_claims`): create (policy is filled from the
  visit date automatically by the database), update status, amounts and rejection reason.
- Reports (computed in the browser from readable rows): no-show rate, average
  wait, utilisation per clinician for a date range.

### 6.5 Rating moderation (`/staff/ratings`)
- List ratings with comments; set `moderation_status` to hidden or flagged for
  abusive or clinical content (never for being negative).

---

## 7. Cross-cutting

- Loading, empty and error states everywhere; toasts for every write; confirm destructive actions.
- Map database errors to friendly messages (e.g. "Slot is no longer available").
- Security headers (CSP allowing only Supabase, Google Maps and the Edge Function URL).
- Privacy page with the consent wording used in 4.5.

---

## 8. Phases (stop after each with what you built, test results and new decisions)

1. **Foundation:** app scaffold, design system, layouts for 3 portals, Supabase clients, auth (login, sign-up, reset, MFA, role routing, middleware), mock data layer, types, `useLiveQuery`.
2. **Patient profile and onboarding** (4.1).
3. **Patient home, map, booking and My appointments** (4.2–4.4).
4. **Staff portal** (6.1–6.5).
5. **Appointment day for patients and clinicians:** consent, recording, transcript review, feedback (4.5–4.7, 5.2 consult controls).
6. **Clinician portal** remainder (5.1, 5.3, 5.4).
7. **Hardening:** accessibility pass, security headers, Playwright suite in mock mode, README (setup, env vars, mock vs live, deployment to Vercel).
