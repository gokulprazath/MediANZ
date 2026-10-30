# MediANZ web (Part A)

One Next.js site with three portals: **patient** (`/patient`), **clinician**
(`/clinician`) and **clinic staff** (`/staff`). Part A uses only the existing
Supabase backend (tables, RLS, RPCs and the `transcribe-consult` Edge Function).
Spec: `docs/FRONTEND_SPEC_A_NOW.md`; decisions and assumptions:
`docs/FRONTEND_DECISIONS.md`.

Stack: Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind v4,
shadcn/ui, TanStack Query, react-hook-form + zod, FullCalendar v7,
`@vis.gl/react-google-maps`, Vitest, Playwright + axe.

## Setup

Requires Node 20.9 or later.

```bash
cd web
npm ci
cp .env.example .env.local   # optional in mock mode
npm run dev                  # http://localhost:3000
```

## Environment variables

| Variable | Needed | What it is |
| --- | --- | --- |
| `NEXT_PUBLIC_DATA_MODE` | no | `mock` (default) or `live` |
| `NEXT_PUBLIC_SUPABASE_URL` | live | Project URL, e.g. `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | live | The anon / publishable key. The service role key is never used. |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | no | Maps JavaScript API key, restricted by HTTP referrer. Without it the finder shows the list view and a note. |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | no | Map id for advanced markers (defaults to Google's `DEMO_MAP_ID`). |

`NEXT_PUBLIC_*` values are built into the browser bundle, so change them and rebuild.
The transcription endpoint is derived from the Supabase URL
(`/functions/v1/transcribe-consult`).

## Mock mode vs live mode

- **Mock** (default): every screen works with an in-memory copy of
  `supabase/seed/01-03` (same ids and names, dates relative to today). The mock
  store emulates the RLS policies, RPCs, triggers and check constraints, and
  raises the same errors as Postgres. It lives in the Next.js server's memory
  (`/api/mock`), so several browser windows share it; it resets on restart or
  `POST /api/mock/reset`. No audio is sent anywhere: recording sends only the
  blob size, and a placeholder transcript is stored.
- **Live**: supabase-js with the signed-in user's session, so RLS applies. MFA
  (TOTP) is required for clinicians and staff.

### Demo accounts (mock mode)

Password `medianz-demo` for all; clinicians and staff then enter the code `123456`.

| Email | Role |
| --- | --- |
| `olivia.brown@example.com` | Patient: history, upcoming visit, approved transcript |
| `jack.wilson@example.com` | Patient: a no-show and a 3-star rating |
| `priya.sharma@example.com` | Patient: visa and insurance changed; claims |
| `lukas.becker@example.com` | Patient: transcript waiting for review |
| `asha.rao@example.com` | Clinician: Southbank Family Medical |
| `sophie.williams@example.com` | Clinician: Paddington GP Clinic |
| `reception.southbank@example.com` | Staff (reception) |

The seed has no appointments today. To try consent and recording, check a
patient in from **Staff → Visits → Open → Check in** (any booked visit), then
open `/patient/appointments/<id>/live` and `/clinician/appointments/<id>`.

## Scripts

```bash
npm run dev          # dev server
npx tsc --noEmit     # type check
npm run lint         # ESLint
npm test             # Vitest unit and component tests (tests/unit)
npm run test:e2e     # Playwright in mock mode, with axe (tests/e2e)
npm run build        # production build
```

The e2e suite starts `next dev` on port 3200 (override with `E2E_PORT`) with
`NEXT_PUBLIC_DATA_MODE=mock`, resets the mock database before each test, runs in
the `Australia/Brisbane` time zone and uses Chromium's fake microphone. If your
Chromium is not the build Playwright pins, set `PW_CHROMIUM_PATH` to its binary.

## Deploying to Vercel

1. Import the repository and set the **root directory** to `web`.
2. Set the environment variables above for Production (and Preview). For a real
   deployment use `NEXT_PUBLIC_DATA_MODE=live`.
3. In Supabase Auth settings, add the deployment URL to the redirect URLs
   (`https://<your-domain>/auth/callback`) so email links work.
4. Restrict the Google Maps key to the deployment's domain.

Mock mode's in-memory database is per server instance: on Vercel's serverless
functions each instance has its own copy and it is lost when the instance
stops, so data seems to reset or differ between requests. Use mock mode for
local development, demos on a single `next start` server and tests only.
