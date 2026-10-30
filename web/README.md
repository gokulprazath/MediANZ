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
| `GOOGLE_PLACES_API_KEY` | no | Server-only (the same key as the Python services). Lets Find care accept any Australian suburb or postcode through `/api/places/lookup` (Places Text Search, signed-in users only); without it only the sample suburbs in `config/postcodes.ts` are known. |
| `NEXT_PUBLIC_DEMO_LOGIN` | no | `true` shows "Demo account" on the login page in live mode (mock mode always shows it). |
| `DEMO_LOGIN_ENABLED`, `DEMO_PASSWORD` | demo login | Server-only: turn the live demo login on, and the demo accounts' password. Optional `DEMO_PATIENT_EMAIL`, `DEMO_CLINICIAN_EMAIL`, `DEMO_RECEPTIONIST_EMAIL`. |

### Demo login for evaluators

The login page's **Demo account** tab (link straight to it with `/login?demo`) offers
Patient (Olivia Brown), Clinician (Dr Asha Rao) and Receptionist (Southbank front desk),
all at Southbank Family Medical. In live mode `/api/demo-login` signs in with the demo
password (anon key, so RLS applies; no service role) and sets an HttpOnly `mz_demo`
cookie. With it, the proxy lets the demo clinician and receptionist into `/clinician`
and `/staff` without the MFA step; any other sign-in of those accounts still needs MFA.

The data is shared: evaluators see each other's bookings, approvals and answers.

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

In live mode, `supabase/seed/07_olivia_demo_data.sql` gives Olivia a visit with Dr Rao that is
already checked in (re-run it for a fresh one). In mock mode the seed has no appointments today. To try consent and recording, check a
patient in from **Staff → Visits → Open → Check in** (any booked visit), then
open `/patient/appointments/<id>/live` and `/clinician/appointments/<id>`.

## Part B: AI agent features

| Screen | Who | Backend it uses |
| --- | --- | --- |
| `/patient/assistant` | Patient | Agent service `/chat` (records, insurance and fees agents) and `/chat/confirm` (sends a GP question only after the patient approves it); `gp_queries` for "My questions" |
| `/patient/find` (Find care) | Patient | AI care finder and clinic map on one page. Discovery API: problem text → ranked clinics with cost estimate (numbered on the map) → hold → book with the quoted gap; or browse every clinic in range. `/patient/concierge` redirects here. |
| `/patient/assistant` booking | Patient | Agent service `/chat` (booking agent: `find_gp_candidates`, `get_available_slots`, `propose_booking`); the patient's Confirm calls `confirm_booking_proposal` |
| `/clinician/review` and the appointment view | Clinician | `consult_key_points`, `clinical_facts`, `open_items`, `gp_queries`, `transcript_segments` and the approve / edit / reject / resolve / answer functions |
| "I've arrived" on `/patient/appointments/<id>/live` | Patient | `patient_check_in` |
| `/staff/operations` | Staff | `get_agent_activity`, `get_engine_activity`, `model_registry`, discovery research drafts |

Server-only variables (never `NEXT_PUBLIC_`):

| Variable | What it is |
| --- | --- |
| `AGENT_SERVICE_URL` | `python -m healthmcp.agent` (default `http://localhost:3108`) |
| `DISCOVERY_SERVICE_URL` | `uvicorn healthmcp.discovery.app:app` (`http://localhost:3109` in the root README) |

The browser only calls `/api/agents/...` on this site. That route forwards an
allowlist of endpoints with the signed-in user's Supabase token, so the
services and RLS decide access. In mock mode the same route answers offline
with deterministic stand-ins (`src/lib/mock/agents.ts`).

### Part B: live

1. Run `supabase/migrations/20261030000000_partb_live_agents.sql` in the SQL
   Editor (after every earlier migration and seeds 01–05).
2. Start the MCP servers, the gateway, the agent service, the discovery API and
   the consult-notes worker (root `Makefile`: `make servers`, `make gateway`,
   `make agent`, `uv run uvicorn healthmcp.discovery.app:app --port 3109`,
   `make consult-worker`).
3. Set `NEXT_PUBLIC_DATA_MODE=live`, the Supabase URL and anon key, and the two
   service URLs in `web/.env.local`, then `npm run dev`.
4. Walk through: Olivia asks the assistant about her medication → approves the
   GP question → Dr Rao opens the review queue (drafts appear once the worker
   has processed Olivia's approved transcript) → approves the facts and answers
   → Olivia sees the answer and the assistant now answers from the approved facts.
   Jack books through Find care, and asks the assistant to book (Confirm on the card). Staff open AI operations.

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

Production: https://medianz.vercel.app (evaluator demo login at `/login?demo`).

One Vercel project runs everything (`vercel.json` at the repo root, services mode):

| Part | What it is | Reachable |
| --- | --- | --- |
| `web` (service, `web/`) | This Next.js app | Public: every path |
| `backend` (service, repo root) | `vercel_backend:app`: the agent at `/agent` and discovery at `/discovery`, with the gateway and the seven MCP servers in the same process (`src/healthmcp/backend.py`) | Internal only: `web` reaches it over the binding `BACKEND_URL` |
| `consult-worker` (daemon) | `Dockerfile.worker`: the consult-notes loop | No traffic; Production deployments only (daemons are in beta) |

1. Import the repository with the **repo root** as the project root (not `web`).
2. Environment variables (Production): everything in the root `.env.example` and in
   `web/.env.example`, with `NEXT_PUBLIC_DATA_MODE=live`. Do **not** set
   `BACKEND_URL` (Vercel injects it), `AGENT_SERVICE_URL` or `DISCOVERY_SERVICE_URL`.
   `DATABASE_URL` must be the Supabase **pooler** connection string (Connect, then
   Transaction or Session pooler): the direct `db.<ref>.supabase.co` host is IPv6
   only and Vercel connects over IPv4. Suggested: `DB_POOL_MIN_SIZE=0`,
   `DB_POOL_MAX_SIZE=3`.
3. In Supabase Auth settings, add the deployment URL to the redirect URLs
   (`https://<your-domain>/auth/callback`) so email links work.
4. Restrict the Google Maps key to the deployment's domain.
5. Check: sign in at `https://<your-domain>/login?demo`, ask the assistant something,
   and record a short consult (the worker drafts notes about a minute after approval).

`vercel dev` runs both services locally (not the daemon: run
`docker build -f Dockerfile.worker -t medianz-worker . && docker run --env-file .env medianz-worker`,
or `make consult-worker`). Without Vercel, the services still run separately
(`make servers`, `make gateway`, `make agent`, the discovery API) and the proxy uses
`AGENT_SERVICE_URL` and `DISCOVERY_SERVICE_URL`.

Mock mode's in-memory database is per server instance: on Vercel's serverless
functions each instance has its own copy and it is lost when the instance
stops, so data seems to reset or differ between requests. Use mock mode for
local development, demos on a single `next start` server and tests only.
